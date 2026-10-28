"""Translate Word's structured Office Math to portable, untrusted-input-safe TeX.

The source model is OMML, not a string of LaTeX. Text runs are escaped, and only
recognized structure creates commands. Unsupported structures are reported to
the importer, which retains source XML and the original DOCX package.
"""
from __future__ import annotations

import re
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass

MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
MATH_NAMESPACES = {MATH_NS, 'http://purl.oclc.org/ooxml/officeDocument/math'}
WORD_NAMESPACES = {'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
                   'http://purl.oclc.org/ooxml/wordprocessingml/main'}

GREEK = dict(zip('αβγδεζηθικλμνξπρστυφχψω',
 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega'.split()))
GREEK.update(dict(zip('ΓΔΘΛΞΠΣΥΦΨΩ', 'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'.split())))
GREEK.update({'ϵ':'varepsilon','ϑ':'vartheta','ϕ':'varphi','ϱ':'varrho','ς':'varsigma','ϖ':'varpi'})
SYMBOLS = {'−':'-', '×':r'\times ', '÷':r'\div ', '·':r'\cdot ', '±':r'\pm ', '∓':r'\mp ',
 '↑':r'\uparrow ', '↓':r'\downarrow ', '↕':r'\updownarrow ', '⇑':r'\Uparrow ',
 '⇓':r'\Downarrow ', '⇕':r'\Updownarrow ', '↗':r'\nearrow ', '↘':r'\searrow ',
 '↖':r'\nwarrow ', '↙':r'\swarrow ', '↦':r'\mapsto ',
 '≤':r'\le ', '≥':r'\ge ', '≠':r'\ne ', '≈':r'\approx ', '≡':r'\equiv ', '∞':r'\infty ',
 '∂':r'\partial ', '∇':r'\nabla ', '∈':r'\in ', '∉':r'\notin ', '∪':r'\cup ', '∩':r'\cap ',
 '⊂':r'\subset ', '⊆':r'\subseteq ', '⊃':r'\supset ', '⊇':r'\supseteq ', '∅':r'\emptyset ',
 '∀':r'\forall ', '∃':r'\exists ', '→':r'\to ', '←':r'\leftarrow ', '↔':r'\leftrightarrow ',
 '⇒':r'\Rightarrow ', '⇔':r'\Leftrightarrow ', '∑':r'\sum ', '∏':r'\prod ', '∫':r'\int ',
 '∬':r'\iint ', '∭':r'\iiint ', '∮':r'\oint ', '√':r'\surd ', 'ℝ':r'\mathbb{R}',
 'ℤ':r'\mathbb{Z}', 'ℕ':r'\mathbb{N}', 'ℚ':r'\mathbb{Q}', 'ℂ':r'\mathbb{C}',
 '…':r'\ldots ', '⋯':r'\cdots ', '⋮':r'\vdots ', '⋱':r'\ddots ', '∝':r'\propto '}
NARY = {'∑':r'\sum','∏':r'\prod','∐':r'\coprod','∫':r'\int','∬':r'\iint',
        '∭':r'\iiint','∮':r'\oint','⋃':r'\bigcup','⋂':r'\bigcap','⋁':r'\bigvee','⋀':r'\bigwedge'}
FUNCTIONS = set('sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln exp lim liminf limsup max min det gcd Pr dim arg ker deg'.split())
ACCENTS = {'\u0302':'hat','^':'hat','\u0303':'tilde','~':'tilde','\u0304':'bar','¯':'bar',
           '\u0307':'dot','\u0308':'ddot','\u20d7':'vec','→':'vec','\u0300':'grave',
           '\u0301':'acute','\u0306':'breve','\u030c':'check'}
PROPERTIES = {'rPr','ctrlPr','argPr','oMathParaPr','fPr','sSupPr','sSubPr','sSubSupPr','sPrePr',
 'radPr','naryPr','dPr','mPr','mrPr','eqArrPr','funcPr','limLowPr','limUppPr','accPr','barPr','boxPr','borderBoxPr','groupChrPr'}
CHILDREN = {'oMathPara':{'oMath','oMathParaPr'}, 'r':{'rPr','t','lastRenderedPageBreak'}, 'f':{'fPr','num','den'},
 'sSup':{'sSupPr','e','sup'}, 'sSub':{'sSubPr','e','sub'}, 'sSubSup':{'sSubSupPr','e','sub','sup'},
 'sPre':{'sPrePr','e','sub','sup'}, 'rad':{'radPr','deg','e'}, 'nary':{'naryPr','sub','sup','e'},
 'd':{'dPr','e'}, 'm':{'mPr','mr'}, 'mr':{'e'}, 'eqArr':{'eqArrPr','e'},
 'func':{'funcPr','fName','e'}, 'limLow':{'limLowPr','lim','e'}, 'limUpp':{'limUppPr','lim','e'},
 'acc':{'accPr','e'}, 'bar':{'barPr','e'}, 'box':{'boxPr','e'}, 'borderBox':{'borderBoxPr','e'}, 'groupChr':{'groupChrPr','e'}}


def split_tag(tag: str) -> tuple[str, str]:
    namespace, _, name = tag[1:].partition('}') if tag.startswith('{') else ('', '', tag)
    return namespace, name


def local(element: ET.Element) -> str:
    return split_tag(element.tag)[1]


def math_element(element: ET.Element) -> bool:
    return split_tag(element.tag)[0] in MATH_NAMESPACES


def child(element: ET.Element, name: str) -> ET.Element | None:
    return next((item for item in element if math_element(item) and local(item)==name), None)


def value(element: ET.Element | None, default: str = '') -> str:
    if element is None:
        return default
    return next((text for key,text in element.attrib.items() if split_tag(key)[1]=='val'), '')


def flag(element: ET.Element | None) -> bool:
    return element is not None and value(element, 'true').lower() not in ('0','false','off')


def text_literal(text: str) -> str:
    replacements = {'\\':r'\textbackslash{}','{':r'\{','}':r'\}','$':r'\$',
                    '%':r'\%','&':r'\&','#':r'\#','_':r'\_','^':r'\textasciicircum{}','~':r'\textasciitilde{}'}
    return ''.join(replacements.get(character, character) for character in text)


def tex_literal(text: str, alignment: bool = False) -> str:
    out = []
    replacements = {'\\':r'\backslash ','{':r'\{','}':r'\}','$':r'\$', '%':r'\%',
                    '&':'&' if alignment else r'\&','#':r'\#','_':r'\_',
                    '^':r'\text{\textasciicircum}', '~':r'\text{\textasciitilde}', '|':r'\vert '}
    for character in text:
        if character in ('\u0332','\u0333') and out:
            previous=out.pop()
            underlined=r'\underline{'+previous+'}'
            out.append((r'\underline{'+underlined+'}') if character=='\u0333' else underlined)
            continue
        if 0x1D400 <= ord(character) <= 0x1D7FF or character=='ℎ':
            character = unicodedata.normalize('NFKC', character)
        if character in GREEK:
            out.append('\\'+GREEK[character]+' ')
        else:
            fallback = (r'\text{'+text_literal(character)+'}') if any(ord(item)>127 for item in character) else character
            out.append(SYMBOLS.get(character, replacements.get(character, fallback)))
    return ''.join(out)


class UnsupportedMath(ValueError):
    pass


@dataclass(frozen=True)
class Equation:
    latex: str | None
    text: str
    warnings: tuple[str, ...] = ()


class Translator:
    def argument(self, element: ET.Element, name: str, alignment: bool = False) -> str:
        found = child(element,name)
        if found is None:
            raise UnsupportedMath(f'{local(element)} is missing its {name} argument')
        return self.render(found,alignment)

    def sequence(self, element: ET.Element, alignment: bool = False) -> str:
        return ''.join(self.render(item,alignment) for item in element)

    def render(self, element: ET.Element, alignment: bool = False) -> str:
        namespace, name = split_tag(element.tag)
        if namespace in WORD_NAMESPACES:
            if name in ('rPr','bookmarkStart','bookmarkEnd','proofErr','lastRenderedPageBreak','del','moveFrom'):
                return ''
            if name in ('ins','moveTo'):
                return self.sequence(element,alignment)
            raise UnsupportedMath(f'Word {name} inside an equation needs review')
        if namespace not in MATH_NAMESPACES:
            raise UnsupportedMath(f'unknown equation namespace for {name}')
        if name in PROPERTIES:
            return ''
        if name in CHILDREN and any(local(item) not in CHILDREN[name] for item in element):
            raise UnsupportedMath(f'unrecognized child of Word math {name}')
        if name=='oMathPara':
            rows=[self.render(item,alignment) for item in element if local(item)=='oMath']
            if not rows:
                raise UnsupportedMath('empty display equation')
            return rows[0] if len(rows)==1 else r'\begin{gathered}'+r' \\ '.join(rows)+r'\end{gathered}'
        if name in ('oMath','e','num','den','sub','sup','deg','lim','fName'):
            return self.sequence(element,alignment)
        if name=='t':
            return tex_literal(element.text or '',alignment)
        if name=='r':
            raw=''.join(item.text or '' for item in element if local(item)=='t')
            properties=child(element,'rPr')
            if properties is not None and flag(child(properties,'nor')):
                return r'\text{'+text_literal(raw)+'}'
            result=self.sequence(element,alignment)
            if properties is not None:
                style=value(child(properties,'sty'))
                script=value(child(properties,'scr'))
                command={'double-struck':'mathbb','script':'mathcal','fraktur':'mathfrak',
                         'sans-serif':'mathsf','monospace':'mathtt','roman':'mathrm'}.get(script)
                if command:
                    result='\\'+command+'{'+result+'}'
                if style in ('b','bi'):
                    result=r'\boldsymbol{'+result+'}'
                elif style=='p' and not command:
                    result=r'\mathrm{'+result+'}'
                if alignment and flag(child(properties,'aln')):
                    result='&'+result
            return result
        if name=='f':
            num,den=self.argument(element,'num',alignment),self.argument(element,'den',alignment)
            properties=child(element,'fPr')
            kind=value(child(properties,'type')) if properties is not None else ''
            if kind in ('','bar'):
                return r'\frac{'+num+'}{'+den+'}'
            if kind in ('lin','skw'):
                return '{'+num+r'}/{'+den+'}'
            if kind=='noBar':
                return r'\genfrac{}{}{0pt}{}{'+num+'}{'+den+'}'
            raise UnsupportedMath(f'fraction style {kind} needs review')
        if name in ('sSup','sSub','sSubSup','sPre'):
            base=self.argument(element,'e',alignment)
            sub='_{'+self.argument(element,'sub',alignment)+'}' if name in ('sSub','sSubSup','sPre') else ''
            sup='^{'+self.argument(element,'sup',alignment)+'}' if name in ('sSup','sSubSup','sPre') else ''
            return '{}'+sub+sup+'{'+base+'}' if name=='sPre' else '{'+base+'}'+sub+sup
        if name=='rad':
            body=self.argument(element,'e',alignment)
            degree=child(element,'deg')
            properties=child(element,'radPr')
            hidden=properties is not None and flag(child(properties,'degHide'))
            root=self.render(degree,alignment) if degree is not None and not hidden else ''
            return r'\sqrt'+('['+root+']' if root else '')+'{'+body+'}'
        if name=='nary':
            properties=child(element,'naryPr')
            operator=value(child(properties,'chr'),'∫') if properties is not None else '∫'
            if operator not in NARY:
                raise UnsupportedMath(f'n-ary operator {operator or "(empty)"} needs review')
            expression=NARY[operator]
            location=value(child(properties,'limLoc')) if properties is not None else ''
            if location=='undOvr':
                expression+=r'\limits'
            elif location=='subSup':
                expression+=r'\nolimits'
            for key,marker,hide in (('sub','_','subHide'),('sup','^','supHide')):
                argument=child(element,key)
                hidden=properties is not None and flag(child(properties,hide))
                content=self.render(argument,alignment) if argument is not None and not hidden else ''
                if content:
                    expression+=marker+'{'+content+'}'
            return expression+'{'+self.argument(element,'e',alignment)+'}'
        if name=='d':
            properties=child(element,'dPr')
            begin=value(child(properties,'begChr'),'(') if properties is not None else '('
            end=value(child(properties,'endChr'),')') if properties is not None else ')'
            separator=value(child(properties,'sepChr'),'|') if properties is not None else '|'
            delimiters={'':' .','(':'(',')':')','[':'[',']':']','{':r'\{','}':r'\}',
                        '|':r'\vert ','‖':r'\Vert ','⟨':r'\langle ','⟩':r'\rangle ',
                        '⌊':r'\lfloor ','⌋':r'\rfloor ','⌈':r'\lceil ','⌉':r'\rceil '}
            if begin not in delimiters or end not in delimiters:
                raise UnsupportedMath('unrecognized enclosing delimiter')
            entries=[self.render(item,alignment) for item in element if local(item)=='e']
            if not entries:
                raise UnsupportedMath('delimiter has no argument')
            sep=r'\mid ' if separator=='|' else tex_literal(separator,alignment)
            return r'\left'+delimiters[begin]+sep.join(entries)+r'\right'+delimiters[end]
        if name=='m':
            if any(local(cell)!='e' for row in element if local(row)=='mr' for cell in row):
                raise UnsupportedMath('matrix row contains an unrecognized argument')
            rows=[[self.render(cell,alignment) for cell in row if local(cell)=='e']
                  for row in element if local(row)=='mr']
            if not rows or not all(rows) or len({len(row) for row in rows})!=1:
                raise UnsupportedMath('matrix rows are missing or inconsistent')
            return r'\begin{matrix}'+r' \\ '.join(' & '.join(row) for row in rows)+r'\end{matrix}'
        if name=='eqArr':
            rows=[self.render(item,True) for item in element if local(item)=='e']
            if not rows:
                raise UnsupportedMath('equation array has no rows')
            environment='aligned' if any(re.search(r'(?<!\\)&',row) for row in rows) else 'gathered'
            return '\\begin{'+environment+'}'+r' \\ '.join(rows)+'\\end{'+environment+'}'
        if name=='func':
            function=child(element,'fName')
            if function is None:
                raise UnsupportedMath('function has no name')
            raw=''.join(item.text or '' for item in function.iter() if local(item)=='t').strip()
            simple=all(local(item) in ('r','rPr','t') for item in function.iter() if item is not function)
            if simple and raw in FUNCTIONS:
                function_name='\\'+raw+' '
            else:
                function_name=r'\operatorname{\text{'+text_literal(raw)+'}}' if raw and simple else self.render(function,alignment)
            return function_name+'{'+self.argument(element,'e',alignment)+'}'
        if name in ('limLow','limUpp'):
            command='underset' if name=='limLow' else 'overset'
            base=self.argument(element,'e',alignment)
            if base in FUNCTIONS:
                base='\\'+base+' '
            return '\\'+command+'{'+self.argument(element,'lim',alignment)+'}{'+base+'}'
        if name=='acc':
            properties=child(element,'accPr')
            accent=value(child(properties,'chr'),'\u0302') if properties is not None else '\u0302'
            if accent not in ACCENTS:
                raise UnsupportedMath(f'accent {accent or "(empty)"} needs review')
            return '\\'+ACCENTS[accent]+'{'+self.argument(element,'e',alignment)+'}'
        if name=='bar':
            properties=child(element,'barPr')
            position=value(child(properties,'pos'),'top') if properties is not None else 'top'
            return ('\\underline{' if position=='bot' else '\\overline{')+self.argument(element,'e',alignment)+'}'
        if name=='box':
            return self.argument(element,'e',alignment)
        if name=='borderBox':
            properties=child(element,'borderBoxPr')
            if properties is not None and any(local(item).startswith(('hide','strike')) and flag(item) for item in properties):
                raise UnsupportedMath('partially hidden or struck border box needs review')
            return r'\boxed{'+self.argument(element,'e',alignment)+'}'
        if name=='groupChr':
            properties=child(element,'groupChrPr')
            character=value(child(properties,'chr'),'⏟') if properties is not None else '⏟'
            command={'⏞':'overbrace','⏟':'underbrace','→':'overrightarrow','←':'overleftarrow'}.get(character)
            if not command:
                raise UnsupportedMath(f'group character {character or "(empty)"} needs review')
            return '\\'+command+'{'+self.argument(element,'e',alignment)+'}'
        raise UnsupportedMath(f'unsupported Word math structure {name}')


def convert(element: ET.Element) -> Equation:
    text=' '.join(item.text or '' for item in element.iter() if local(item)=='t').strip()
    try:
        pending=[(element,0)]
        count=0
        while pending:
            item,depth=pending.pop()
            count+=1
            if depth>80 or count>20_000:
                raise UnsupportedMath('equation complexity exceeds the converter limit')
            pending.extend((node,depth+1) for node in item)
        latex=Translator().render(element).strip()
        if not latex:
            raise UnsupportedMath('empty Word equation')
        if len(latex)>200_000:
            raise UnsupportedMath('equation length exceeds the converter limit')
        return Equation(latex,text)
    except (UnsupportedMath,RecursionError) as error:
        return Equation(None,text,(str(error) or 'equation nesting needs review',))
