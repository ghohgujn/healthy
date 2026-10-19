# Собирает однофайловое превью (демо-режим, заглушка API) из public/ — для показа без сервера.
import re, sys
d = 'public/'
h = open(d + 'index.html').read()
links = '\n'.join(re.findall(r'<link[^>]+fonts\.googleapis[^>]+>', h))
body = re.search(r'<body>(.*)</body>', h, re.S).group(1)
for s in ('calc.js', 'app.js', 'social.js', 'onboarding.js'): body = body.replace(f'<script src="{s}"></script>', '')
js = lambda f: '<script>' + open(f).read() + '</script>'
out = f'''<title>Healthy Fit</title>
<meta name="claude:viewport-fit-sides" content="cover">
{links}
<style>
{open(d + 'tokens.css').read()}
{open(d + 'app.css').read()}
</style>
<script>window.KBJU_CONFIG = {{ apiBase: '', demo: true }};</script>
{body}
{js(d + 'calc.js')}
{js(d + 'app.js')}
{js('demo/mock-api.js')}
{js(d + 'social.js')}
{js(d + 'onboarding.js')}'''
open(sys.argv[1], 'w').write(out)
print(len(out))
