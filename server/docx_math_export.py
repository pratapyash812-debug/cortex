"""Bounded LaTeX subset to editable Office Math; unsupported source is never discarded."""
import re
from xml.etree import ElementTree as E
M='http://schemas.openxmlformats.org/officeDocument/2006/math'
def el(tag,*children,**attrs):
    n=E.Element('{%s}%s'%(M,tag),{'{%s}%s'%(M,k):v for k,v in attrs.items()});n.extend(children);return n
def run(text,normal=False):
    t=el('t');t.text=text;t.set('{http://www.w3.org/XML/1998/namespace}space','preserve')
    return el('r',*([el('rPr',el('nor'))] if normal else []),t)
SYMBOLS=dict(zip('alpha beta gamma delta epsilon varepsilon theta lambda mu pi sigma phi omega Delta Sigma Pi Omega'.split(),'α β γ δ ε ε θ λ μ π σ φ ω Δ Σ Π Ω'.split()))
SYMBOLS.update({'cdot':'·','times':'×','div':'÷','pm':'±','approx':'≈','Rightarrow':'⇒','rightarrow':'→','le':'≤','leq':'≤','ge':'≥','geq':'≥','ne':'≠','in':'∈','infty':'∞','dots':'…','ldots':'…'})
def equation(source):
    if len(source)>16000:raise ValueError('Equation too long')
    aligned=re.fullmatch(r'\s*\\begin\{aligned\}([\s\S]*?)\\end\{aligned\}\s*',source)
    if aligned:
        rows=aligned.group(1).split('\\\\')
        if len(rows)>100:raise ValueError('Too many equation rows')
        return el('oMath',el('eqArr',*[el('e',*Parser(row.replace('&','')).parse()) for row in rows]))
    return el('oMath',*Parser(source).parse())
class Parser:
    def __init__(self,s):self.t=re.findall(r'\\[a-zA-Z]+|\\.|\d+(?:\.\d+)?|\s+|[^\s]',s);self.i=0;self.depth=0
    def skip(self):
        while self.i<len(self.t) and self.t[self.i].isspace():self.i+=1
    def raw(self,op='{',cl='}'):
        self.skip()
        if self.i>=len(self.t) or self.t[self.i]!=op:raise ValueError('Missing group')
        self.i+=1;start=self.i;depth=1
        while self.i<len(self.t):
            v=self.t[self.i];self.i+=1
            if v==op:depth+=1
            if v==cl:depth-=1
            if not depth:return ''.join(self.t[start:self.i-1])
        raise ValueError('Unclosed group')
    def arg(self):
        self.skip()
        if self.i>=len(self.t):raise ValueError('Missing argument')
        if self.t[self.i]=='{':self.i+=1;return self.parse('}')
        return [self.atom()]
    def atom(self):
        self.skip()
        if self.i>=len(self.t):raise ValueError('Missing symbol')
        token=self.t[self.i];self.i+=1
        if token=='{':return el('box',el('e',*self.parse('}')))
        if not token.startswith('\\'):return run(token)
        cmd=token[1:]
        if cmd in ('left','right','displaystyle','textstyle'):return self.atom()
        if cmd in ('quad','qquad',',',';',':',' '):return run(' ')
        if cmd in ('frac','dfrac','tfrac'):
            num=self.arg();den=self.arg();return el('f',el('num',*num),el('den',*den))
        if cmd=='sqrt':
            degree=self.raw('[',']') if self.i<len(self.t) and self.t[self.i]=='[' else ''
            return el('rad',el('radPr',el('degHide',val='0' if degree else '1')),el('deg',*Parser(degree).parse()),el('e',*self.arg()))
        if cmd=='binom':return self.binomial(self.arg(),self.arg())
        if cmd in ('text','mathrm','operatorname','mathbb'):
            text=self.raw();return run('ℝ' if cmd=='mathbb' and text=='R' else text,True)
        if cmd in ('sin','cos','tan','log','ln','exp','lim'):return run(cmd,True)
        if cmd in SYMBOLS:return run(SYMBOLS[cmd])
        if cmd in ('{','}','%','$','_','#','&'):return run(cmd)
        raise ValueError('Unsupported equation command: '+cmd)
    @staticmethod
    def binomial(num,den):return el('d',el('dPr',el('begChr',val='('),el('endChr',val=')')),el('e',el('f',el('fPr',el('type',val='noBar')),el('num',*num),el('den',*den))))
    def parse(self,end=None):
        self.depth+=1
        if self.depth>40:raise ValueError('Equation too nested')
        out=[]
        while self.i<len(self.t):
            token=self.t[self.i]
            if token.isspace():self.i+=1;continue
            if token==end:self.i+=1;self.depth-=1;return out
            if token=='\\choose':self.i+=1;return [self.binomial(out,self.parse(end))]
            if token in ('^','_'):
                self.i+=1
                if not out:raise ValueError('Script without base')
                base=out.pop();out.append(el('sSup' if token=='^' else 'sSub',el('e',base),el('sup' if token=='^' else 'sub',*self.arg())))
            else:out.append(self.atom())
        self.depth-=1
        if end:raise ValueError('Unclosed equation group')
        return out
