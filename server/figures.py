"""Small local study figures. Expressions use a bounded AST, never Python eval.

SVGs are ordinary portable attachments; editable source stays in .cortex/figures.
Editing creates a new attachment so another note using the old graph is unchanged.
"""
from __future__ import annotations
import ast
import csv
import html
import io
import json
import math
import os
from pathlib import Path
import re
import tempfile
import textwrap
import uuid

COLORS = ['#747bff', '#1da4a1', '#e99537', '#d75a87']
FUNCTIONS = {name: getattr(math, name) for name in ['sin','cos','tan','asin','acos','atan','sqrt','exp','log','log10','floor','ceil']}
FUNCTIONS.update({'ln': math.log, 'abs': abs})
ID = re.compile(r'^[0-9a-f]{32}$')

def text(value, fallback='', limit=100):
    if value is None: return fallback
    if not isinstance(value, str): raise ValueError('Labels must be text.')
    if len(value) > limit: raise ValueError(f'Keep labels under {limit} characters.')
    return ''.join(c for c in value.strip() if ord(c) >= 32) or fallback

def number(value, label):
    if isinstance(value, bool): raise ValueError(f'{label} must be a finite number.')
    try: result = float(value)
    except (ValueError, TypeError): raise ValueError(f'{label} must be a finite number.') from None
    if not math.isfinite(result) or abs(result) > 1e12: raise ValueError(f'{label} must be finite and between -1e12 and 1e12.')
    return result

def expression(source):
    source = text(source, limit=160)
    source = re.sub(r'^\s*y\s*=\s*', '', source, flags=re.I).replace('²','^2').replace('³','^3').replace('π', 'pi').replace('−', '-')
    source = re.sub(r'(?<=[0-9])(?=x\b|pi\b|e\b)', '*', source).replace('^','**')
    try: tree = ast.parse(source, mode='eval')
    except (SyntaxError, ValueError): raise ValueError('Check the function. Use x, powers (^), and * for multiplication.') from None
    if len(list(ast.walk(tree))) > 80: raise ValueError('Use a shorter function.')
    def validate(node, depth=0):
        if depth > 12: raise ValueError('Use a simpler function.')
        if isinstance(node, ast.Expression): validate(node.body, depth+1)
        elif isinstance(node, ast.Constant) and type(node.value) in (int,float): number(node.value,'Constant')
        elif isinstance(node, ast.Name) and node.id in ('x','pi','e'): pass
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op,(ast.UAdd,ast.USub)): validate(node.operand,depth+1)
        elif isinstance(node, ast.BinOp) and isinstance(node.op,(ast.Add,ast.Sub,ast.Mult,ast.Div,ast.Pow)):
            validate(node.left,depth+1);validate(node.right,depth+1)
        elif isinstance(node, ast.Call) and isinstance(node.func,ast.Name) and node.func.id in FUNCTIONS and len(node.args)==1 and not node.keywords:
            validate(node.args[0],depth+1)
        else: raise ValueError('Use numbers, x, pi, e, + - * / ^, and functions such as sin(x), sqrt(x), or ln(x).')
    validate(tree)
    def evaluate(node,x):
        if isinstance(node,ast.Expression): return evaluate(node.body,x)
        if isinstance(node,ast.Constant): return float(node.value)
        if isinstance(node,ast.Name): return x if node.id=='x' else math.pi if node.id=='pi' else math.e
        if isinstance(node,ast.UnaryOp):
            value=evaluate(node.operand,x);return -value if isinstance(node.op,ast.USub) else value
        if isinstance(node,ast.Call): return FUNCTIONS[node.func.id](evaluate(node.args[0],x))
        a,b=evaluate(node.left,x),evaluate(node.right,x)
        if isinstance(node.op,ast.Add): return a+b
        if isinstance(node.op,ast.Sub): return a-b
        if isinstance(node.op,ast.Mult): return a*b
        if isinstance(node.op,ast.Div): return a/b
        if abs(b)>100: raise ValueError('Power too large')
        return math.pow(a,b)
    def sample(x):
        try:
            y=evaluate(tree,x)
            return y if math.isfinite(y) and abs(y)<=1e12 else None
        except (ArithmeticError,ValueError): return None
    return source,sample

def numeric_cell(value, decimal_comma=False):
    value=value.strip().replace('\u00a0','').replace(' ','').replace('−','-')
    if not value: return None
    if value.endswith('%'): value=value[:-1]
    if decimal_comma:
        if re.fullmatch(r'[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?',value): value=value.replace('.','').replace(',','.')
        elif ',' in value: raise ValueError('Check the decimal-comma number.')
    elif re.fullmatch(r'[+-]?\d{1,3}(,\d{3})+(\.\d+)?',value): value=value.replace(',','')
    return number(value,'Cell')

def data_rows(source, decimal_comma=False):
    if not isinstance(source,str) or len(source)>60_000: raise ValueError('Paste a table with up to 200 data rows and four value columns.')
    tabbed='\t' in source
    try: rows=[row for row in csv.reader(io.StringIO(source),delimiter='\t' if tabbed else ',',strict=True) if any(v.strip() for v in row)]
    except csv.Error: raise ValueError('Check the pasted table or CSV quotation marks.') from None
    if len(rows)<2 or len(rows)>201: raise ValueError('Include a header and between 1 and 200 data rows.')
    columns=len(rows[0])
    if columns<2 or columns>5: raise ValueError('Use one label column and between one and four value columns.')
    headers=[text(v,f'Column {i+1}',60) for i,v in enumerate(rows[0])]
    parsed=[]
    for i,row in enumerate(rows[1:],2):
        if len(row)!=columns: raise ValueError(f'Row {i} has {len(row)} cells; the header has {columns}.')
        label=text(row[0],str(i-1),60)
        values=[]
        for j,value in enumerate(row[1:],2):
            try: values.append(numeric_cell(value,decimal_comma))
            except ValueError: raise ValueError(f'Row {i}, column {j} needs a number or an empty cell.') from None
        parsed.append((label,values))
    if not any(v is not None for _,values in parsed for v in values): raise ValueError('Add at least one numeric value.')
    return headers,parsed

def normalize(raw):
    if not isinstance(raw,dict): raise ValueError('Choose a graph type.')
    kind=raw.get('kind','function')
    if kind not in ('function','line','bar','diagram'): raise ValueError('Choose Function, Line, Bar, or Flowchart.')
    out={'kind':kind,'title':text(raw.get('title'),'Graph' if kind!='diagram' else 'Flowchart'),
         'xLabel':text(raw.get('xLabel'),'x' if kind=='function' else '',60),'yLabel':text(raw.get('yLabel'),'y' if kind=='function' else '',60),
         'theme':'light' if raw.get('theme')=='light' else 'dark'}
    if kind=='function':
        expressions=raw.get('expressions',['x^2'])
        if not isinstance(expressions,list) or not 1<=len(expressions)<=4: raise ValueError('Add between one and four functions.')
        out['expressions']=[expression(v)[0] for v in expressions]
        out['xMin']=number(raw.get('xMin',-5),'Minimum x');out['xMax']=number(raw.get('xMax',5),'Maximum x')
        if out['xMin']>=out['xMax'] or out['xMax']-out['xMin']<1e-9: raise ValueError('Maximum x must be greater than minimum x.')
    elif kind=='diagram':
        nodes=raw.get('steps',[])
        if not isinstance(nodes,list) or not 2<=len(nodes)<=16: raise ValueError('Add between 2 and 16 steps, one per line.')
        out['steps']=[text(v,limit=100) for v in nodes]
        if any(not v for v in out['steps']): raise ValueError('Give every step a label.')
    else:
        source=raw.get('data','');out['numberFormat']='decimal-comma' if raw.get('numberFormat')=='decimal-comma' else 'english'
        data_rows(source,out['numberFormat']=='decimal-comma');out['data']=source
    return out

def fmt(value):
    if abs(value)<1e-10: return '0'
    return f'{value:.4g}'

def render(raw):
    config=normalize(raw);kind=config['kind'];dark=config['theme']=='dark'
    bg,fg,muted,grid=('#1c1e24','#ebedf1','#a9afbc','#3b404c') if dark else ('#ffffff','#20242b','#626b79','#dfe4eb')
    escaped=lambda value:html.escape(str(value),quote=True)
    pieces=[]
    def label(x,y,value,size=13,anchor='middle',color=None):
        pieces.append(f'<text x="{x:.2f}" y="{y:.2f}" text-anchor="{anchor}" fill="{color or fg}" font-size="{size}">{escaped(value)}</text>')
    if kind=='diagram':
        width=760;height=95+len(config['steps'])*85
        for i,value in enumerate(config['steps']):
            y=62+i*85
            if i: pieces.append(f'<path d="M380 {y-24}V{y-6}m-5-5 5 5 5-5" fill="none" stroke="{muted}" stroke-width="2"/>')
            pieces.append(f'<rect x="65" y="{y}" width="630" height="57" rx="12" fill="{bg}" stroke="{grid}" stroke-width="2"/>')
            # Wrap long user labels rather than clipping them.
            lines=textwrap.wrap(value,width=65,break_long_words=True)
            for j,line in enumerate(lines[:2]): label(380,y+25+j*18,line,14)
        summary=f'{len(config["steps"])} steps: '+' → '.join(config['steps'])
    else:
        width,height=860,490;left,right,top,bottom=80,820,60,365
        function=kind=='function'
        if function:
            xmin,xmax=config['xMin'],config['xMax'];series=[];valid=[]
            for source in config['expressions']:
                _,fn=expression(source);points=[(xmin+(xmax-xmin)*i/500,fn(xmin+(xmax-xmin)*i/500)) for i in range(501)]
                series.append((source,points));valid.extend(y for _,y in points if y is not None)
            if not valid: raise ValueError('No real values in this range. Try a different function or x range.')
            ymin,ymax=min(valid),max(valid);labels=[]
            summary='Functions: '+', '.join(config['expressions'])+f'; x from {fmt(xmin)} to {fmt(xmax)}.'
        else:
            headers,rows=data_rows(config['data'],config['numberFormat']=='decimal-comma');labels=[r[0] for r in rows]
            all_numeric=True;xs=[]
            for i,value in enumerate(labels):
                try: xs.append(number(value,'Label'))
                except ValueError: all_numeric=False;break
            if not all_numeric or len(set(xs))<len(xs): xs=list(range(len(rows)))
            if kind=='bar': xs=list(range(len(rows)))
            xmin,xmax=min(xs),max(xs)
            if kind=='bar': xmin-=.6;xmax+=.6
            if xmin==xmax: xmin-=.5;xmax+=.5
            series=[(name,[(xs[i],row[1][j]) for i,row in enumerate(rows)]) for j,name in enumerate(headers[1:])]
            valid=[v for _,values in rows for v in values if v is not None]
            ymin,ymax=min(0,min(valid)),max(0,max(valid))
            summary=f'{len(rows)} data rows; series: '+', '.join(headers[1:])+'. Empty cells stay missing.'+(' Percent values use percentage points.' if '%' in config['data'] else '')
        if ymin==ymax: ymin-=max(1,abs(ymin)*.1);ymax+=max(1,abs(ymax)*.1)
        else:
            padding=(ymax-ymin)*.08;ymin-=padding;ymax+=padding
        sx=lambda x:left+(x-xmin)/(xmax-xmin)*(right-left)
        sy=lambda y:bottom-(y-ymin)/(ymax-ymin)*(bottom-top)
        for i in range(6):
            y=ymin+(ymax-ymin)*i/5;yp=sy(y)
            pieces.append(f'<path d="M{left} {yp:.2f}H{right}" stroke="{grid}"/>');label(left-10,yp+4,fmt(y),12,'end',muted)
        if ymin<=0<=ymax: pieces.append(f'<path d="M{left} {sy(0):.2f}H{right}" stroke="{muted}"/>')
        if function:
            for i in range(6):
                x=xmin+(xmax-xmin)*i/5;xp=sx(x)
                pieces.append(f'<path d="M{xp:.2f} {top}V{bottom}" stroke="{grid}"/>');label(xp,bottom+22,fmt(x),12,color=muted)
            if xmin<=0<=xmax: pieces.append(f'<path d="M{sx(0):.2f} {top}V{bottom}" stroke="{muted}"/>')
        else:
            stride=max(1,math.ceil(len(labels)/10))
            for i,value in enumerate(labels):
                if i%stride==0 or i==len(labels)-1: label(sx(xs[i]),bottom+22,value if len(value)<=13 else value[:12]+'…',11,color=muted)
        for si,(name,points) in enumerate(series):
            color=COLORS[si]
            if kind=='bar':
                bar_width=min(45,(right-left)/max(2,len(points))*0.75/len(series))
                for x,y in points:
                    if y is None:continue
                    xp=sx(x)+(si-(len(series)-1)/2)*bar_width
                    yp=min(sy(y),sy(0));h=max(.8,abs(sy(y)-sy(0)))
                    pieces.append(f'<rect x="{xp-bar_width/2:.2f}" y="{yp:.2f}" width="{bar_width*.88:.2f}" height="{h:.2f}" fill="{color}" rx="2"/>')
            else:
                path=[];previous=None
                for x,y in points:
                    if y is None: previous=None;continue
                    # Don't draw a connecting segment across sampled poles/jumps.
                    jump=previous is None or (function and abs(y-previous)>(ymax-ymin)*.45)
                    path.append(f'{"M" if jump else "L"}{sx(x):.2f} {sy(y):.2f}');previous=y
                pieces.append(f'<path d="{" ".join(path)}" stroke="{color}" stroke-width="2.6" fill="none" stroke-linejoin="round"/>')
                if not function and len(points)<=40:
                    for x,y in points:
                        if y is not None: pieces.append(f'<circle cx="{sx(x):.2f}" cy="{sy(y):.2f}" r="3.5" fill="{color}"/>')
            label(100+(si%2)*390,440+(si//2)*22,'— '+(name if len(name)<48 else name[:47]+'…'),12,'start',color)
        label((left+right)/2,417,config['xLabel'],13,color=muted)
        pieces.append(f'<text transform="translate(21 {(top+bottom)/2}) rotate(-90)" text-anchor="middle" fill="{muted}" font-size="13">{escaped(config["yLabel"])}</text>')
    label(width/2,30,config['title'],18)
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc"><title id="title">{escaped(config["title"])}</title><desc id="desc">{escaped(summary)}</desc><rect width="100%" height="100%" rx="14" fill="{bg}"/><g font-family="Segoe UI,Arial,sans-serif">'+''.join(pieces)+'</g></svg>'
    return {'config':config,'svg':svg,'summary':summary}

def atomic(path,content):
    path.parent.mkdir(parents=True,exist_ok=True);temporary=None
    try:
        with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=path.parent,prefix='.',suffix='.tmp',delete=False) as stream:
            temporary=Path(stream.name);stream.write(content);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path);temporary=None
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)

def save(root:Path,raw):
    result=render(raw);identity=uuid.uuid4().hex
    image=f'attachments/figures/figure-{identity}.svg'
    atomic(root/image,result['svg'])
    atomic(root/'.cortex/figures'/f'{identity}.json',json.dumps({'version':1,'id':identity,'image':image,'config':result['config']},ensure_ascii=False))
    return {'id':identity,'image':image,'markdown':f'![[{image}]]','config':result['config']}

def read(root:Path,identity):
    if not isinstance(identity,str) or not ID.fullmatch(identity):raise ValueError('This graph has no editable source in Cortex.')
    try: stored=json.loads((root/'.cortex/figures'/f'{identity}.json').read_text(encoding='utf-8'))
    except FileNotFoundError:raise ValueError('The graph image is available, but its editable source is missing.') from None
    return {'id':identity,'config':normalize(stored['config'])}


def sketch_svg(strokes, title='Sketch', options=None):
    """Portable inert snapshot of already validated freehand strokes, for note exports."""
    min_x=min_y=float('inf');max_x=max_y=float('-inf')
    for stroke in strokes:
        for i in range(0,len(stroke['points']),2):
            x=number(stroke['points'][i],'Coordinate');y=number(stroke['points'][i+1],'Coordinate')
            min_x=min(min_x,x);min_y=min(min_y,y);max_x=max(max_x,x);max_y=max(max_y,y)
    if not strokes:min_x=min_y=0;max_x=300;max_y=180
    if options and options.get('axes'):
        min_x=min(min_x,0);min_y=min(min_y,0);max_x=max(max_x,100);max_y=max(max_y,0)
    left=min_x-30;top=min_y-30;width=max(100,max_x-left+30);height=max(100,max_y-top+30)
    paths=[]
    if options and options.get('grid'):
        paths.append('<defs><pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#ddd" stroke-width=".5"/></pattern></defs>')
        paths.append(f'<rect x="{left}" y="{top}" width="{width}" height="{height}" fill="url(#grid)"/>')
    if options and options.get('axes'):
        paths.append(f'<path d="M{left} 0H{left+width}M0 {top}V{top+height}" fill="none" stroke="#555" stroke-width="1"/>')
    for stroke in strokes:
        values=stroke['points'];path='M'+' L'.join(f'{values[i]} {values[i+1]}' for i in range(0,len(values),2))
        color=stroke['color'] if re.fullmatch(r'#[a-fA-F0-9]{3,8}|[a-zA-Z]{1,20}',stroke['color']) else '#e5484d'
        paths.append(f'<path d="{path}" fill="none" stroke="{color}" stroke-width="{number(stroke["width"],"Width")}" stroke-linecap="round" stroke-linejoin="round"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left} {top} {width} {height}" role="img"><title>{html.escape(title)}</title><rect x="{left}" y="{top}" width="{width}" height="{height}" fill="white"/>'+''.join(paths)+'</svg>'
