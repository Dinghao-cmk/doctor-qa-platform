import fitz
import sys

path = r'c:\在水医方\agent-qc-node-master\51. 医患沟通（第3版）n.pdf'
doc = fitz.open(path)
toc = doc.get_toc()

print(f'总页数: {len(doc)}')
print(f'目录项: {len(toc)}')
print()

for level, title, page in toc[:100]:
    indent = '  ' * (level - 1)
    print(f'{indent}{title} (p.{page})')

doc.close()
