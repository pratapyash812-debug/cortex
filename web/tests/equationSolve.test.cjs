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
    '(-1)!', '1.5!', '70!', '2^999', 'x+1', '2x=4', '2=3', '\\int_0^1 x dx', '\\placeholder{}',
    '2+', '(2+3', '\\sqrt{}', '\\frac12', '9007199254740993', '1.0000000000000001', '2^{-2000}',
    '9'.repeat(513), '('.repeat(41)+'1'+')'.repeat(41),
    'globalThis.process.exit()', '\\htmlData{evil}{2}', 'NaN', 'Infinity']) {
    assert.throws(() => solve(source), Error, source);
  }
}));
