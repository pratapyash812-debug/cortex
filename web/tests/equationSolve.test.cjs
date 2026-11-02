const assert = require('node:assert/strict');
const test = require('node:test');
const {environment} = require('./helpers/paletteHost.cjs');

function withSolver(work) { const env = environment(); try { work(env.load('equationSolve.ts').solveEquation); } finally { env.restore(); } }

test('student product example, implicit multiplication and factorials retain the original calculation', () => withSolver(solve => {
  const source = '\\left(5\\cdot4\\cdot3\\cdot2\\cdot1\\right)\\left(2\\cdot1\\right)';
  assert.equal(solve(source).completed, source + '=240');
  assert.equal(solve('5!2!').text, '240');
  assert.equal(solve('0!').text, '1');
  assert.equal(solve('(5·4·3·2·1)(2·1)=').completed, '(5·4·3·2·1)(2·1)=240');
}));

test('calculator honours precedence, fractions, roots, percentages and radians', () => withSolver(solve => {
  for (const [source, expected] of [['2+3*4',14], ['-2^2',-4], ['(-2)^2',4], ['2^3^2',512],
    ['2^{-3}',0.125], ['\\frac{3}{\\frac{1}{2}}',6], ['\\sqrt{9}',3], ['\\sqrt[3]{-8}',-2],
    ['200*15\\%',30], ['\\sin(0)',0], ['\\cos(0)',1], ['\\log(100)',2], ['\\ln(e)',1], ['\\pi',Math.PI]]) {
    assert.ok(Math.abs(Number(solve(source).text) - expected) < 1e-10, source);
  }
  assert.equal(solve('0.1+0.2').text, '0.3');
  assert.equal(solve('0.1+0.2').approximate, true);
  assert.match(solve('1/3').completed, /\\approx0\.333333333333$/);
  assert.match(solve('69!').latex, /\\times 10\^\{98\}/);
}));

test('undefined, unsupported, incomplete and oversized calculations fail explicitly', () => withSolver(solve => {
  for (const source of ['', '1/0', '\\frac{1}{0}', '\\sqrt{-1}', '\\ln(0)', '\\tan(\\pi/2)',
    '(-1)!', '1.5!', '70!', '2^999', 'x+1', '2=3', '\\int_0^1 x dx', '\\placeholder{}',
    '2+', '(2+3', '\\sqrt{}', '\\frac12', '9007199254740993', '1.0000000000000001', '2^{-2000}',
    '9'.repeat(513), '('.repeat(41)+'1'+')'.repeat(41),
    'globalThis.process.exit()', '\\htmlData{evil}{2}', 'NaN', 'Infinity']) {
    assert.throws(() => solve(source), Error, source);
  }
}));

test('linear equations use exact fractions, explain operations and verify both original sides',()=>withSolver(solve=>{
  for(const [source,answer] of [['2x+3=11','x = 4'],['3(x-2)=x+4','x = 5'],['\\frac{x}{3}+1=3','x = 6'],
    ['0.1x+0.2=0.5','x = 3'],['-2x+1=4','x = -3/2'],['x/2=1/3','x = 2/3'],['x=0','x = 0']]){
    const result=solve(source);assert.equal(result.text,answer,source);assert.equal(result.approximate,false);
    assert.match(result.steps.at(-1).title,/Check: substitute/);const sides=result.steps.at(-1).latex.split('=');assert.equal(sides[0],sides[1]);
    for(const latex of [result.completed,result.working,...result.steps.map(s=>s.latex)])require('katex').renderToString(latex,{throwOnError:true});
  }
}));

test('quadratics distinguish two roots, repeated roots, irrational roots and no real roots',()=>withSolver(solve=>{
  assert.equal(solve('x^2-5x+6=0').text,'x = 3 or x = 2');
  assert.equal(solve('(x-2)^2=0').text,'x = 2');
  assert.equal(solve('x²=9').text,'x = 3 or x = -3');
  const radical=solve('x^2=2');assert.equal(radical.approximate,true);assert.match(radical.latex,/\\sqrt/);assert.match(radical.text,/1\.41421356237/);
  const none=solve('x^2+1=0');assert.equal(none.text,'No real solution');assert.match(none.steps.at(-1).title,/negative/);
  for(const result of [radical,none,solve('-x^2+x+2=0'),solve('0.5x^2-1.5x+1=0')]){
    for(const latex of [result.completed,result.working,...result.steps.map(s=>s.latex)])require('katex').renderToString(latex,{throwOnError:true});
  }
}));

test('degenerate equations and unsupported algebra cannot silently lose restrictions',()=>withSolver(solve=>{
  assert.equal(solve('2(x+1)=2x+2').text,'Every real value of x');
  assert.equal(solve('2x+1=2x+2').text,'No solution');
  for(const source of ['1/x=2','x/x=1','\\frac{x}{x}=1','x^3=1','x^-2=1','2x+y=4','\\sin(x)=0','\\sqrt{x}=2','x=','x=1=2','(x+1=3','x/0=1'])assert.throws(()=>solve(source),Error,source);
}));

test('planted quadratic roots are recovered independently across signs and expansions',()=>withSolver(solve=>{
  for(const a of [-3,1,2])for(const r of [-4,0,3])for(const s of [-2,1,3]){
    const result=solve(`${a}(x-(${r}))(x-(${s}))=0`);
    const roots=[...result.text.matchAll(/x = (-?\d+(?:\/\d+)?)/g)].map(m=>{const [n,d=1]=m[1].split('/').map(Number);return n/d;}).sort((a,b)=>a-b);
    assert.deepEqual(roots,[...new Set([r,s])].sort((a,b)=>a-b),result.text);
  }
}));
