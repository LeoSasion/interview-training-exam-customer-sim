import json, base64, urllib.request, os, sys

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent':'wb-ref','Accept':'application/vnd.github+json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def blob(repo, sha, out):
    j = get(f'https://api.github.com/repos/{repo}/git/blobs/{sha}')
    data = base64.b64decode(j['content'])
    with open(out,'wb') as f: f.write(data)
    print('OK', out, len(data))

AWS='aws-samples/sample-ai-sales-roleplay'
AZ='Azure-Samples/voicelive-api-salescoach'
os.makedirs('img', exist_ok=True)
jobs = [
 (AWS,'e6666930647c78c01d55f2648d14ca51e5ca2f77','img/aws_demo1.png'),
 (AWS,'fec26161c2f4da766101ffc8d1c77361c06f643e','img/aws_demo2.png'),
 (AWS,'ea0e2f7b8da5625b92384fd80cf33680af042b01','img/aws_demo3.png'),
 (AWS,'b0c2211348b96546deb69487c12799781e07a5ed','img/aws_demo4.png'),
 (AWS,'1b7293edbe53b4c07cad9babe2af9e54c09ce02c','img/aws_arch.png'),
 (AWS,'129738d72c67df00ae2937aff4d474517ac4d404','img/aws_scenario_goal.png'),
 (AWS,'fb36f0d59d9f3bd24af77862a61564ced5985d74','img/aws_scenario_basic.png'),
 (AWS,'e808917f64b6016de02b92f4d5495274b73cf88a','img/aws_scenario_list.png'),
 (AZ,'6836eaa9d16bbc5d0152616161fa84257f447fa5','img/az_preview.png'),
 (AZ,'fa9491c595ddc108161844decaa90f18f32c5119','img/az_analysis.png'),
]
for repo, sha, out in jobs:
    try: blob(repo, sha, out)
    except Exception as e: print('FAIL', out, e)

# 可运行的交互式 Demo 页面
try:
    j = get('https://api.github.com/repos/crymarch/interactive-chat-simulation-template/git/blobs/1692db2d7293e83c25b6421d3054bcf1633d15df')
    open('interactive-chat-simulation-demo.html','wb').write(base64.b64decode(j['content']))
    print('OK demo html', os.path.getsize('interactive-chat-simulation-demo.html'))
except Exception as e:
    print('FAIL demo', e)
