// Run with: npm test   (needs Playwright + Chromium)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const lib = fs.readFileSync(path.join(root, 'candy.js'), 'utf8');
let browser;
let errors;

before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

async function open(target) {
  const page = await browser.newPage();
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (target.endsWith('.html')) {
    await page.goto(pathToFileURL(path.join(root, target)).href);
  } else {
    await page.setContent(`<!DOCTYPE html><html><head><script>${lib}</script></head><body>${target}</body></html>`);
  }
  await page.waitForTimeout(20);
  return page;
}

const tick = (page) => page.waitForTimeout(10);

test('parseTemplate handles nesting and strings', async () => {
  const page = await open('<p></p>');
  const parts = await page.evaluate(() => Candy.parseTemplate("a {x.map(i => { return '}' + i })} b \\{lit}"));
  assert.deepEqual(parts, ['a ', { expr: "x.map(i => { return '}' + i })" }, ' b {lit}']);
  assert.equal(await page.evaluate(() => Candy.parseTemplate('no braces')), null);
});

test('text and attribute bindings react to state', async () => {
  const page = await open(`
    <hello-js><p title="hi {this.state.name}">Hello {this.state.name}!</p></hello-js>
    <script>class Hello extends Candy { state = { name: 'Ali' } } Hello.register();</script>`);
  assert.equal(await page.textContent('p'), 'Hello Ali!');
  assert.equal(await page.getAttribute('p', 'title'), 'hi Ali');
  await page.evaluate(() => { document.querySelector('hello-js').state.name = 'Mona'; });
  await tick(page);
  assert.equal(await page.textContent('p'), 'Hello Mona!');
  assert.equal(await page.getAttribute('p', 'title'), 'hi Mona');
  assert.deepEqual(errors, []);
});

test('event handlers: method reference, inline statement and event local', async () => {
  const page = await open(`
    <c-js>
      <button id="a" onclick="{this.inc}">a</button>
      <button id="b" onclick="{this.state.n += 10}">b</button>
      <input id="i" oninput="{this.state.text = event.target.value}">
      <span id="out">{this.state.n} {this.state.text}</span>
    </c-js>
    <script>class C extends Candy { state = { n: 0, text: '' }; inc() { this.state.n++ } } C.register('c-js');</script>`);
  await page.click('#a');
  await page.click('#b');
  await page.fill('#i', 'yo');
  await tick(page);
  assert.equal(await page.textContent('#out'), '11 yo');
  assert.deepEqual(errors, []);
});

test('each + if directives keep in sync with arrays', async () => {
  const page = await open(`
    <list-js>
      <ul><template each="{this.state.items}" as="it" index="i"><li>{i}:{it}</li></template></ul>
      <template if="{!this.state.items.length}"><p id="empty">empty</p></template>
      <template else><p id="count">{this.state.items.length}</p></template>
    </list-js>
    <script>class List extends Candy { state = { items: ['a', 'b'] } } List.register();</script>`);
  const items = () => page.$$eval('li', (els) => els.map((e) => e.textContent));
  assert.deepEqual(await items(), ['0:a', '1:b']);
  assert.equal(await page.textContent('#count'), '2');
  await page.evaluate(() => document.querySelector('list-js').state.items.push('c'));
  await tick(page);
  assert.deepEqual(await items(), ['0:a', '1:b', '2:c']);
  await page.evaluate(() => document.querySelector('list-js').state.items.splice(0, 1));
  await tick(page);
  assert.deepEqual(await items(), ['0:b', '1:c']);
  await page.evaluate(() => { document.querySelector('list-js').state.items = []; });
  await tick(page);
  assert.deepEqual(await items(), []);
  assert.equal(await page.$('#empty') !== null, true);
  assert.equal(await page.$('#count'), null);
  assert.deepEqual(errors, []);
});

test('props and callbacks flow between components; refs resolve by name', async () => {
  const page = await open(`
    <parent-js ref="app">
      <child-js label="{this.state.label}" onpick="{this.pick}"></child-js>
      <span id="picked">{this.state.picked}</span>
      <b ref="badge">x</b>
    </parent-js>
    <script>
      class Child extends Candy {
        label = ''; onPick = null;
        static template = '<button id="btn" onclick="{this.onPick(this.label)}">{this.label} {badge.tagName}</button>';
      }
      class Parent extends Candy {
        state = { label: 'one', picked: '' };
        pick(v) { this.state.picked = v; }
      }
      Child.register(); Parent.register();
    </script>`);
  assert.equal(await page.textContent('#btn'), 'one B');
  await page.click('#btn');
  await tick(page);
  assert.equal(await page.textContent('#picked'), 'one');
  await page.evaluate(() => { document.querySelector('parent-js').state.label = 'two'; });
  await tick(page);
  assert.equal(await page.textContent('#btn'), 'two B');
  assert.deepEqual(errors, []);
});

test('emit() custom events are caught by on<name> attributes', async () => {
  const page = await open(`
    <host-js><kid-js onping="{this.state.got = event.detail}"></kid-js><i id="o">{this.state.got}</i></host-js>
    <script>
      class Kid extends Candy { onMount() { this.emit('ping', 42); } }
      class Host extends Candy { state = { got: 0 } }
      Kid.register(); Host.register();
    </script>`);
  await tick(page);
  assert.equal(await page.textContent('#o'), '42');
});

test('<script type="text/candy"> renders HTML and compiles it', async () => {
  const page = await open(`
    <s-js>
      <script type="text/candy">this.state.xs.map(x => '<em onclick="{this.state.last = ' + x + '}">' + x + '</em>')</script>
      <span id="last">{this.state.last}</span>
    </s-js>
    <script>class S extends Candy { state = { xs: [1, 2, 3], last: 0 } } S.register('s-js');</script>`);
  assert.deepEqual(await page.$$eval('em', (e) => e.map((x) => x.textContent)), ['1', '2', '3']);
  await page.click('em >> nth=1');
  await tick(page);
  assert.equal(await page.textContent('#last'), '2');
  assert.deepEqual(errors, []);
});

test('examples/counter.html', async () => {
  const page = await open('examples/counter.html');
  assert.equal(await page.textContent('strong'), '0');
  await page.click('text=+');
  await page.click('text=+');
  await page.click('text=−');
  await tick(page);
  assert.equal(await page.textContent('strong'), '1');
  assert.equal(await page.textContent('p'), 'odd');
  assert.deepEqual(errors, []);
});

test('examples/todo.html', async () => {
  const page = await open('examples/todo.html');
  const texts = () => page.$$eval('.item span', (e) => e.map((x) => x.textContent));
  assert.deepEqual(await texts(), ['Try CandyJS', 'Build something sweet']);
  assert.equal(await page.textContent('.count'), '1 left');
  assert.equal(await page.isDisabled('todo-form-js button'), true);

  await page.fill('todo-form-js input', 'Write tests');
  await page.click('todo-form-js button');
  await tick(page);
  assert.deepEqual(await texts(), ['Try CandyJS', 'Build something sweet', 'Write tests']);
  assert.equal(await page.inputValue('todo-form-js input'), '');
  assert.equal(await page.textContent('.count'), '2 left');

  await page.check('.item >> nth=1 >> input');
  await tick(page);
  assert.equal(await page.textContent('.count'), '1 left');

  await page.click('footer button:text("active")');
  await tick(page);
  assert.deepEqual(await texts(), ['Write tests']);

  await page.click('footer button:text("done")');
  await tick(page);
  assert.deepEqual(await texts(), ['Try CandyJS', 'Build something sweet']);

  await page.click('text=Clear done');
  await tick(page);
  assert.equal(await page.isVisible('.empty'), true);

  await page.click('footer button:text("all")');
  await page.click('.item button');
  await tick(page);
  assert.deepEqual(await texts(), []);
  assert.deepEqual(errors, []);
});
