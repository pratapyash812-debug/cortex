/** Small, bounded numeric calculator for equation drafts. No eval, network or AI. */
export interface EquationAnswer { source: string; latex: string; text: string; approximate: boolean; completed: string }

const unsupported = 'Auto-solve supports numerical calculations, fractions, powers, roots and factorials. Letters, algebraic equations and calculus are not supported yet.';

export function solveEquation(input: string): EquationAnswer {
  const source = input.trim().replace(/=\s*$/, '').trim();
  if (!source) throw new Error('Write a calculation first.');
  if (source.length > 512) throw new Error('This calculation is too long to auto-solve.');
  if (/\\(?:placeholder|prompt)\b|#\?/.test(source)) throw new Error('Fill in the empty boxes before solving.');
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
