/** Small, bounded numeric calculator for equation drafts. No eval, network or AI. */
export interface SolutionStep { title: string; latex: string }
export interface EquationAnswer { source: string; latex: string; text: string; approximate: boolean; completed: string; steps?: SolutionStep[]; working?: string }

const unsupported = 'Use a numerical calculation or a linear or quadratic equation in x. Equations with other variables, variable denominators and calculus are not supported yet.';

export function solveEquation(input: string): EquationAnswer {
  const source = input.trim().replace(/=\s*$/, '').trim();
  if (!source) throw new Error('Write a calculation first.');
  if (source.length > 512) throw new Error('This calculation is too long to auto-solve.');
  if (/\\(?:placeholder|prompt)\b|#\?/.test(source)) throw new Error('Fill in the empty boxes before solving.');
  if (/(?:^|[^a-zA-Z\\])x(?![a-zA-Z])/.test(source)) return solveAlgebra(source);
  const cleaned = source
    .replace(/\\(?:left|right|displaystyle|textstyle)\b/g, '')
    .replace(/\\(?:,|;|:|!|quad\b|qquad\b| )/g, '')
    .replace(/\\(?:cdot|times)(?![a-zA-Z])|[·×]/g, '*')
    .replace(/\\div(?![a-zA-Z])|÷/g, '/')
    .replace(/\\%/g, '%').replace(/−/g, '-');
  const tokens = cleaned.match(/\\[a-zA-Z]+|(?:\d+(?:\.\d*)?|\.\d+)|[+\-*/^!%(){}[\]]|\S/g) ?? [];
  if (tokens.length > 256) throw new Error('This calculation is too long to auto-solve.');
  let at = 0, depth = 0, inexact = false;
  const peek = () => tokens[at];
  const check = (n: number) => {
    if (!Number.isFinite(n)) throw new Error('This calculation has no finite real-number answer. Check division by zero, roots and powers.');
    if (Math.abs(n) > 1e100) throw new Error('The answer is too large for this calculator.');
    if (!Number.isSafeInteger(n)) inexact = true;
    return n;
  };
  const grouped = (open: string, close: string): number => {
    if (tokens[at++] !== open) throw new Error('Use brackets around fractions, roots and function arguments.');
    if (++depth > 40) throw new Error('This calculation has too many nested brackets.');
    const value = expression();
    if (tokens[at++] !== close) throw new Error('Check that every opening bracket has a closing bracket.');
    depth--; return value;
  };
  const argument = (): number => {
    if (peek() === '{') return grouped('{', '}');
    if (peek() === '(') return grouped('(', ')');
    throw new Error('Put the function argument in brackets, for example sin(0) or \\sqrt{9}.');
  };
  const primary = (): number => {
    const token = peek();
    if (token === '(') return grouped('(', ')');
    if (token === '{') return grouped('{', '}');
    if (token === '[') return grouped('[', ']');
    if (token === '\\frac' || token === '\\dfrac' || token === '\\tfrac') {
      at++; const numerator = argument(), denominator = argument();
      if (!denominator) throw new Error('Division by zero is undefined.');
      return check(numerator / denominator);
    }
    if (token === '\\sqrt') {
      at++; const index = peek() === '[' ? grouped('[', ']') : 2;
      if (!index) throw new Error('A root cannot have index zero.');
      const value = argument();
      if (value < 0 && (!Number.isInteger(index) || Math.abs(index % 2) !== 1)) throw new Error('This root has no real-number answer.');
      inexact = true;
      return check(value < 0 ? -Math.pow(-value, 1 / index) : Math.pow(value, 1 / index));
    }
    const functions: Record<string, (n: number) => number> = {
      '\\sin': Math.sin, '\\cos': Math.cos, '\\tan': n => {
        if (Math.abs(Math.cos(n)) < 1e-14) throw new Error('Tangent is undefined at this angle. Angles use radians.');
        return Math.tan(n);
      },
      '\\ln': Math.log, '\\log': Math.log10, '\\exp': Math.exp,
    };
    if (token in functions) { at++; inexact = true; return check(functions[token](argument())); }
    if (token === '\\pi' || token === 'π' || token === 'e') { at++; inexact = true; return token === 'e' ? Math.E : Math.PI; }
    if (token && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      at++; const n = Number(token);
      if (token.includes('.') && token.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length > 15) throw new Error('Use up to 15 significant digits for decimal numbers to avoid losing precision.');
      if (!n && /[1-9]/.test(token)) throw new Error('This number is too small for the calculator.');
      if (Number.isInteger(n) && !Number.isSafeInteger(n)) throw new Error('Use integers up to 9,007,199,254,740,991 to avoid losing digits.');
      return check(n);
    }
    if (!token) throw new Error('The calculation is incomplete.');
    throw new Error(unsupported);
  };
  const postfix = (): number => {
    let value = primary();
    while (peek() === '!' || peek() === '%') {
      if (tokens[at++] === '%') { value /= 100; continue; }
      if (!Number.isInteger(value) || value < 0 || value > 69) throw new Error('Factorials need a whole number from 0 to 69.');
      let answer = 1;
      for (let n = 2; n <= value; n++) answer *= n;
      value = check(answer);
    }
    return value;
  };
  const power = (): number => {
    const base = postfix();
    if (peek() !== '^') return base;
    at++;
    if (++depth > 40) throw new Error('This calculation has too many nested powers.');
    const exponent = unary(); depth--;
    const value = Math.pow(base, exponent);
    if (!value && base) throw new Error('The answer is too small for the calculator.');
    return check(value);
  };
  const unary = (): number => {
    let sign = 1;
    while (peek() === '+' || peek() === '-') { if (tokens[at++] === '-') sign *= -1; }
    return sign * power();
  };
  const startsPrimary = (token: string | undefined) => !!token && (/^(?:\d|\.|\\|[({[πe])/.test(token));
  const product = (): number => {
    let value = unary();
    while (peek() === '*' || peek() === '/' || startsPrimary(peek())) {
      const operator = peek();
      if (operator === '*' || operator === '/') at++;
      const right = unary();
      if (operator === '/' && !right) throw new Error('Division by zero is undefined.');
      const result = operator === '/' ? value / right : value * right;
      if (!result && value && right) throw new Error('The answer is too small for the calculator.');
      value = check(result);
    }
    return value;
  };
  const expression = (): number => {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const operator = tokens[at++], right = product();
      value = check(operator === '+' ? value + right : value - right);
    }
    return value;
  };
  const value = check(expression());
  if (at !== tokens.length) throw new Error(unsupported);
  // Keep exact safe-integer arithmetic; explicitly mark floating/rounded answers.
  const approximate = inexact || !Number.isSafeInteger(value);
  const text = Object.is(value, -0) ? '0' : approximate ? Number(value.toPrecision(12)).toString() : value.toString();
  const latex = text.replace(/e([+-]?\d+)$/, (_, exponent: string) => `\\times 10^{${Number(exponent)}}`);
  return { source, latex, text, approximate, completed: `${source}${approximate ? '\\approx' : '='}${latex}` };
}

// Exact rational coefficients avoid rounding away a term or inventing a root.
type Rational = { n: bigint; d: bigint };
type Polynomial = Rational[];
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
const rational = (n: bigint, d = 1n): Rational => {
  if (!d) throw new Error('Division by zero is undefined.');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d); n /= g; d /= g;
  if (n.toString().length > 65 || d.toString().length > 65) throw new Error('These coefficients are too large. Use smaller numbers to solve this equation.');
  return { n, d };
};
const addR = (a: Rational, b: Rational) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const negR = (a: Rational) => rational(-a.n, a.d);
const mulR = (a: Rational, b: Rational) => rational(a.n * b.n, a.d * b.d);
const divR = (a: Rational, b: Rational) => rational(a.n * b.d, a.d * b.n);
const zero = () => rational(0n);
const rLatex = (r: Rational): string => r.d === 1n ? String(r.n) : `${r.n < 0n ? '-' : ''}\\frac{${r.n < 0n ? -r.n : r.n}}{${r.d}}`;
const rText = (r: Rational) => r.d === 1n ? String(r.n) : `${r.n}/${r.d}`;
const trimP = (p: Polynomial) => { while (p.length > 1 && !p[p.length-1].n) p.pop(); return p; };
const addP = (a: Polynomial, b: Polynomial) => trimP(Array.from({length:Math.max(a.length,b.length)}, (_, i) => addR(a[i] ?? zero(), b[i] ?? zero())));
const mulP = (a: Polynomial, b: Polynomial): Polynomial => {
  const out = Array.from({length:a.length+b.length-1}, zero);
  a.forEach((x, i) => b.forEach((y, j) => { out[i+j] = addR(out[i+j], mulR(x,y)); }));
  trimP(out);
  if (out.length > 3) throw new Error('Auto-solve currently handles linear and quadratic equations in x (degree 1 or 2).');
  return out;
};
function pLatex(p: Polynomial): string {
  const terms: string[] = [];
  for (let i = p.length-1; i >= 0; i--) {
    const r = p[i]; if (!r.n) continue;
    const abs = rational(r.n < 0n ? -r.n : r.n, r.d);
    const coefficient = i && abs.n === abs.d ? '' : rLatex(abs);
    terms.push(`${r.n < 0n ? '-' : terms.length ? '+' : ''}${coefficient}${i ? i === 1 ? 'x' : 'x^2' : ''}`);
  }
  return terms.join('') || '0';
}
function parsePolynomial(source: string): Polynomial {
  const cleaned = source.replace(/\\(?:left|right|displaystyle|textstyle)\b/g,'')
    .replace(/\\(?:,|;|:|!|quad\b|qquad\b| )/g,'').replace(/\\(?:cdot|times)(?![a-zA-Z])|[·×]/g,'*')
    .replace(/\\div(?![a-zA-Z])|÷/g,'/').replace(/−/g,'-').replace(/²/g,'^2');
  const t = cleaned.match(/\\[a-zA-Z]+|(?:\d+(?:\.\d*)?|\.\d+)|\S/g) ?? [];
  if (t.length > 256) throw new Error('This equation is too long to solve.');
  let at = 0, depth = 0;
  const peek = () => t[at];
  const group = (open: string, close: string): Polynomial => {
    if (t[at++] !== open) throw new Error('Put fraction numerators and denominators in braces.');
    if (++depth > 32) throw new Error('This equation has too many nested brackets.');
    const value = expression();
    if (t[at++] !== close) throw new Error('Check that every opening bracket has a closing bracket.');
    depth--; return value;
  };
  const primary = (): Polynomial => {
    const token = peek();
    if (token === '(') return group('(',')');
    if (token === '{') return group('{','}');
    if (token === '[') return group('[',']');
    if (token === 'x') { at++; return [zero(),rational(1n)]; }
    if (token === '\\frac' || token === '\\dfrac' || token === '\\tfrac') {
      at++; const a = group('{','}'), b = group('{','}');
      if (b.length !== 1) throw new Error('Equations with x in a denominator are not supported yet.');
      return a.map(r => divR(r,b[0]));
    }
    if (token && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      at++; const parts = token.split('.');
      return [rational(BigInt((parts[0] || '0')+(parts[1] || '')),10n**BigInt(parts[1]?.length ?? 0))];
    }
    throw new Error(token ? unsupported : 'The equation is incomplete.');
  };
  const power = (): Polynomial => {
    const base = primary(); if (peek() !== '^') return base;
    at++; const exponent = peek() === '{' ? group('{','}') : primary();
    if (exponent.length !== 1 || exponent[0].d !== 1n || exponent[0].n < 0n || exponent[0].n > 2n || peek() === '^') throw new Error('Use powers 0, 1 or 2 when solving for x.');
    return exponent[0].n === 0n ? [rational(1n)] : exponent[0].n === 1n ? base : mulP(base,base);
  };
  const unary = (): Polynomial => {
    let sign = 1; while (peek() === '+' || peek() === '-') if (t[at++] === '-') sign *= -1;
    return power().map(r => sign < 0 ? negR(r) : r);
  };
  const product = (): Polynomial => {
    let value = unary();
    while (peek() === '*' || peek() === '/' || /^(?:\d|\.|x|[({[]|\\frac|\\dfrac|\\tfrac)/.test(peek() ?? '')) {
      const op = peek(); if (op === '*' || op === '/') at++;
      const right = unary();
      if (op === '/') {
        if (right.length !== 1) throw new Error('Equations with x in a denominator are not supported yet.');
        value = value.map(r => divR(r,right[0]));
      } else value = mulP(value,right);
    }
    return value;
  };
  const expression = (): Polynomial => {
    let value = product();
    while (peek() === '+' || peek() === '-') { const op = t[at++], right = product(); value = addP(value, op === '-' ? right.map(negR) : right); }
    return value;
  };
  const result = trimP(expression());
  if (at !== t.length) throw new Error(unsupported);
  return result;
}
const integerSqrt = (n: bigint): bigint => { if (n < 2n) return n; let a=n,b=(a+1n)/2n; while(b<a) { a=b; b=(a+n/a)/2n; } return a; };

function solveAlgebra(source: string): EquationAnswer {
  const sides = source.split('=');
  if (sides.length !== 2 || !sides.every(s=>s.trim())) throw new Error('Include both sides of one equation, for example 2x + 3 = 11.');
  const left = parsePolynomial(sides[0]), right = parsePolynomial(sides[1]);
  const p = addP(left,right.map(negR)), c=p[0], b=p[1] ?? zero(), a=p[2] ?? zero();
  const steps: SolutionStep[] = [{title:'Expand brackets and collect like terms on each side.',latex:`${pLatex(left)}=${pLatex(right)}`},
    {title:'Subtract the right-hand side from both sides, then collect like terms.',latex:`${pLatex(p)}=0`}];
  let latex: string, text: string, approximate=false;
  if (!a.n && !b.n) {
    const identity = !c.n;
    latex = identity ? 'x\\in\\mathbb{R}' : '\\text{No solution}'; text = identity ? 'Every real value of x' : 'No solution';
    steps.push({title:identity?'Both sides are identical, so every real x works.':'This is a contradiction, so no value of x works.',latex:`${rLatex(c)}=0`});
  } else if (!a.n) {
    const value = divR(negR(c),b);
    steps.push({title:`${c.n < 0n ? 'Add' : 'Subtract'} ${rText(rational(c.n < 0n ? -c.n : c.n,c.d))} on both sides to isolate the x term.`,latex:`${pLatex([zero(),b])}=${rLatex(negR(c))}`});
    latex = `x=${rLatex(value)}`; text = `x = ${rText(value)}`;
    steps.push({title:`Divide both sides by ${rText(b)}.`,latex});
    const substitute = (p: Polynomial) => p.reduce((v,coeff,i) => addR(v,mulR(coeff,i===0?rational(1n):i===1?value:mulR(value,value))),zero());
    steps.push({title:`Check: substitute x = ${rText(value)} into the original equation. Both sides match.`,latex:`${rLatex(substitute(left))}=${rLatex(substitute(right))}`});
  } else {
    const fourAC = mulR(rational(4n),mulR(a,c)), discriminant=addR(mulR(b,b),negR(fourAC)), twoA=mulR(rational(2n),a);
    steps.push({title:`Identify a = ${rText(a)}, b = ${rText(b)}, c = ${rText(c)}. Calculate the discriminant.`,latex:`D=b^2-4ac=(${rLatex(b)})^2-4(${rLatex(a)})(${rLatex(c)})=${rLatex(discriminant)}`});
    if (discriminant.n < 0n) {
      latex='\\text{No real solution}';text='No real solution';
      steps.push({title:'The discriminant is negative. There are no real roots (complex roots are not shown).',latex:'D<0'});
    } else {
      steps.push({title:'Use the quadratic formula.',latex:'x=\\frac{-b\\pm\\sqrt{D}}{2a}'});
      const sn=integerSqrt(discriminant.n),sd=integerSqrt(discriminant.d);
      const formula=`\\frac{${rLatex(negR(b))}\\pm\\sqrt{${rLatex(discriminant)}}}{${rLatex(twoA)}}`;
      steps.push({title:'Substitute the coefficients and discriminant.',latex:`x=${formula}`});
      if (sn*sn===discriminant.n && sd*sd===discriminant.d) {
        const delta=rational(sn,sd),one=divR(addR(negR(b),delta),twoA),two=divR(addR(negR(b),negR(delta)),twoA);
        latex=`x=${rLatex(one)}${delta.n ? `\\quad\\text{or}\\quad x=${rLatex(two)}` : ''}`;
        text=`x = ${rText(one)}${delta.n ? ` or x = ${rText(two)}` : ''}`;
        steps.push({title:delta.n?'Simplify each of the two roots.':'The discriminant is zero, so there is one repeated root.',latex});
      } else {
        const bn=Number(b.n)/Number(b.d),an=Number(twoA.n)/Number(twoA.d),dn=Math.sqrt(Number(discriminant.n)/Number(discriminant.d));
        // Use a stable product relation when subtracting nearly equal numbers.
        const first=(-bn-(bn>=0?dn:-dn))/an;
        const second=(Number(c.n)/Number(c.d))/(Number(a.n)/Number(a.d))/first;
        const fmt=(n:number)=>Number(n.toPrecision(12)).toString();
        approximate=true; latex=`x=${formula}`; text=`x ≈ ${fmt(first)} or x ≈ ${fmt(second)}`;
        steps.push({title:'Keep the exact radical answer; these decimal values are approximate.',latex:`x\\approx ${fmt(first).replace(/e([+-]?\d+)$/,(_,e:string)=>`\\times10^{${Number(e)}}`)}\\quad\\text{or}\\quad x\\approx ${fmt(second).replace(/e([+-]?\d+)$/,(_,e:string)=>`\\times10^{${Number(e)}}`)}`});
      }
    }
  }
  const completed=`${source}\\quad\\Rightarrow\\quad ${latex}`;
  // Generated labels contain only fixed English copy and rational numbers.
  const working=`\\begin{aligned}&${source}\\\\${steps.map(s=>`&\\text{${s.title.replace(/[{}\\]/g,'')}}\\\\&${s.latex}`).join('\\\\')}\\end{aligned}`;
  return {source,latex,text,approximate,completed,steps,working};
}
