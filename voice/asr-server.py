# -*- coding: utf-8 -*-
"""
本地 ASR 服务（P11）—— FunASR · SenseVoice-Small，零 Web 框架（标准库 http.server）。

启动（模型缓存在 D:\\wbproject\\_tools\\msc，首次启动若缓存为空会自动下载）：
    D:\\wbproject\\_tools\\asr-venv\\Scripts\\python.exe voice/asr-server.py

接口：
    GET  /health   -> {"ok":true,"model":"SenseVoiceSmall"}
    POST /asr      -> 裸二进制音频（wav 16k 最佳；webm/opus/mp3 自动经 ffmpeg 转 16k 单声道）
                      响应 {"ok":true,"text":"识别文本","infer_ms":123}
                      失败 {"ok":false,"error":"原因"}

设计说明：
    - 与主后端（Node/8848）刻意分离：模型重、启动慢（~5s 加载），独立进程才能被
      独立重启/省略——不装语音就完全不起这个进程，主系统零影响。
    - ffmpeg 用 imageio-ffmpeg 自带的静态二进制（无需系统安装 ffmpeg），
      仅用于把浏览器 MediaRecorder 的 webm/opus 转成 16k 单声道 wav。
    - SenseVoice 输出里的 <|zh|><|NEUTRAL|> 等标签是元信息，一律清洗掉再返回。
"""
import os
import re
import sys
import time
import json
import tempfile
import subprocess
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 模型缓存：默认放 D 盘（C 盘空间紧张），可用 MODELSCOPE_CACHE 覆盖
os.environ.setdefault('MODELSCOPE_CACHE', r'D:\wbproject\_tools\msc')

PORT = int(os.environ.get('ASR_PORT', '8997'))
MAX_BODY = 8 * 1024 * 1024      # 8MB 上限（约 2 分钟压缩语音）

# ---------------------------------------------------------------- 模型
print('[asr] 正在加载 SenseVoiceSmall（首次约 5-30s）…', flush=True)
t0 = time.time()
from funasr import AutoModel  # noqa: E402  延迟 import：先让 MODELSCOPE_CACHE 生效
MODEL = AutoModel(
    model='iic/SenseVoiceSmall',
    trust_remote_code=True,      # remote code 用模型仓库自带（会进缓存），不写相对路径
    disable_update=True,
)
print('[asr] 模型就绪（%.1fs），监听 127.0.0.1:%d' % (time.time() - t0, PORT), flush=True)

try:
    from imageio_ffmpeg import get_ffmpeg_exe
    FFMPEG = get_ffmpeg_exe()
except Exception:
    FFMPEG = None
    print('[asr] 警告：imageio-ffmpeg 不可用，webm/opus/mp3 输入将无法转码（wav 不受影响）', flush=True)

TAG_RE = re.compile(r'<\|[^|]*\|>')


def to_wav_16k(raw: bytes, ext: str, out_path: str) -> str:
    """非 wav（或非 16k wav）统一转成 16k 单声道 wav。"""
    if ext == '.wav':
        with open(out_path, 'wb') as f:
            f.write(raw)
        return out_path
    if not FFMPEG:
        raise RuntimeError('当前输入需要 ffmpeg 转码，但 ffmpeg 不可用')
    src = out_path + '.src'
    with open(src, 'wb') as f:
        f.write(raw)
    r = subprocess.run(
        [FFMPEG, '-y', '-i', src, '-ac', '1', '-ar', '16000', out_path],
        capture_output=True, timeout=30)
    try:
        os.remove(src)
    except OSError:
        pass
    if r.returncode != 0 or not os.path.exists(out_path):
        raise RuntimeError('ffmpeg 转码失败：' + r.stderr.decode('utf-8', 'ignore')[-200:])
    return out_path


def transcribe(raw: bytes, ext: str) -> dict:
    fd, tmp = tempfile.mkstemp(suffix=ext or '.bin')
    os.close(fd)
    try:
        wav = to_wav_16k(raw, ext, tmp + '.wav')
        t0 = time.time()
        res = MODEL.generate(
            input=wav,
            cache={},
            language='zh',        # 培训场景只有中文，锁死语言避免语种误判
            use_itn=True,         # 口语数字转阿拉伯数字（价格话术友好）
            batch_size_s=60,
            merge_vad=True,
        )
        infer_ms = int((time.time() - t0) * 1000)
        text = ''
        if res and isinstance(res, list):
            text = str(res[0].get('text', '') or '')
        text = TAG_RE.sub('', text).strip()
        return {'ok': True, 'text': text, 'infer_ms': infer_ms}
    finally:
        for p in (tmp, tmp + '.wav', tmp + '.wav.src'):
            try:
                os.remove(p)
            except OSError:
                pass


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {'ok': True, 'model': 'SenseVoiceSmall',
                             'ffmpeg': bool(FFMPEG), 'port': PORT})
        else:
            self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if self.path != '/asr':
            self._json(404, {'ok': False, 'error': 'not found'})
            return
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0:
            self._json(400, {'ok': False, 'error': '空请求体'})
            return
        if n > MAX_BODY:
            self._json(413, {'ok': False, 'error': '音频过大（上限 8MB）'})
            return
        raw = self.rfile.read(n)
        ctype = (self.headers.get('Content-Type') or '').lower()
        if 'webm' in ctype:
            ext = '.webm'
        elif 'ogg' in ctype:
            ext = '.ogg'
        elif 'mpeg' in ctype or 'mp3' in ctype:
            ext = '.mp3'
        elif 'wav' in ctype or 'audio' in ctype:
            ext = '.wav'
        elif raw[:4] == b'RIFF':
            ext = '.wav'
        else:
            ext = '.webm'   # MediaRecorder 默认产出，按 webm 处理（ffmpeg 能嗅探）
        try:
            self._json(200, transcribe(raw, ext))
        except Exception as e:                     # noqa: BLE001 转码/识别的任何失败都如实返回
            self._json(500, {'ok': False, 'error': str(e)})

    def log_message(self, fmt, *args):
        print('[asr] ' + (fmt % args), flush=True)


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
