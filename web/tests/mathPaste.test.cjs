const assert=require('node:assert/strict');
const test=require('node:test');
const {environment}=require('./helpers/paletteHost.cjs');
const withPaste=fn=>{const e=environment();document.compatMode='CSS1Compat';try{fn(e.load('mathPaste.ts'));}finally{e.restore();}};

test('Pascal triangle prose and both delimiter escaping styles become portable inline maths',()=>withPaste(({normaliseMathPaste})=>{
  const text=String.raw`- Each row \\(n\\) contains \\(\binom{n}{0}, \binom{n}{1}, \dots, \binom{n}{n}\\).
- In row 8, \\({8 \choose 2}\\) and \({8 \choose 6}\) are mirror images.`;
  const md=normaliseMathPaste(text);
  assert.ok(md.includes('$n$'));assert.ok(md.includes('$\\binom{n}{0}, \\binom{n}{1}, \\dots, \\binom{n}{n}$'));
  assert.ok(md.includes('${8 \\choose 2}$'));assert.ok(md.includes('${8 \\choose 6}$'));assert.equal(md.split('\n').length,2);
}));

test('display maths gets a block while code, existing math and malformed input remain intact',()=>withPaste(({normaliseMathPaste})=>{
  assert.equal(normaliseMathPaste('Before \\[x^2=4\\] after'),'Before \n\n$$\nx^2=4\n$$\n\n after');
  for(const value of ['`\\(x\\)`','``code ` \\(x\\)``','```latex\n\\(x\\)\n```','~~~text\n\\(x\\)\n~~~',
    '$\\(x\\)$','$$\n\\[x\\]\n$$','\\(unfinished','\\(\\notARealCommand{x}\\)','plain (n) and $20',
    '```\n\\(never close','\\(two\nlines\\)'])assert.equal(normaliseMathPaste(value),value,value);
}));
