# Собирает однофайловое превью (демо-режим, заглушка API) из public/ — для показа без сервера.
import re, sys
d = 'public/'
h = open(d + 'index.html').read()
links = '<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700;800&display=swap" rel="stylesheet">'   # превью-артефакт: свои шрифты недоступны
body = re.search(r'<body>(.*)</body>', h, re.S).group(1)
for s in ('calc.js', 'app.js', 'social.js', 'share.js', 'onboarding.js', 'posts.js', 'reports.js'): body = body.replace(f'<script src="{s}"></script>', '')
js = lambda f: '<script>' + open(f).read() + '</script>'
out = f'''<title>Healthy Fit</title>
<meta name="claude:viewport-fit-sides" content="cover">
{links}
<style>
{re.sub(r'@font-face[^}]+}', '', open(d + 'tokens.css').read())}
{open(d + 'app.css').read()}
</style>
<script>window.KBJU_CONFIG = {{ apiBase: '', demo: true }};</script>
{body}
{js(d + 'calc.js')}
{js(d + 'app.js')}
{js('demo/mock-api.js')}
{js(d + 'social.js')}
{js(d + 'share.js')}
{js(d + 'onboarding.js')}
{js(d + 'posts.js')}
{js(d + 'reports.js')}'''
open(sys.argv[1], 'w').write(out)
print(len(out))
