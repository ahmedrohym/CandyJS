# CandyJS 🍬

A tiny, dependency-free UI library built on Web Components. One file, no build step.

```html
<script src="candy.js"></script>

<counter-js>
  <button onclick="{this.state.count--}">−</button>
  {this.state.count}
  <button onclick="{this.state.count++}">+</button>
</counter-js>

<script>
  class Counter extends Candy {
    state = { count: 0 };
  }
  Counter.register();          // defines <counter-js>
</script>
```

Open `examples/counter.html` or `examples/todo.html` in a browser to see it run.

## Components

```js
class TodoItem extends Candy {
  todo = null;                 // a prop, set by the parent
  onRemove = null;             // a callback prop
  state = { editing: false };  // reactive: changes re-render automatically

  static template = `
    <span>{this.todo.text}</span>
    <button onclick="{this.onRemove}">✕</button>`;

  onMount()  {}                // after the first render
  onUpdate() {}                // before every render
}
TodoItem.register('todo-item-js');
```

- `register(tag?)`: the default tag is the class name in lower case plus `-js`, so `Counter` becomes `counter-js`. You can also set `static tag = 'my-tag'`.
- `static template`: an HTML string, or a function that returns one. It's used only when the element has no children of its own, so you can also write the template inline in the page.
- Methods are bound automatically, so `onclick="{this.save}"` works without extra code.
- `this.update()` re-renders right away, and `this.scheduleUpdate()` batches several changes into one render. Changes to `state` call `scheduleUpdate()` for you.
- `this.emit(name, detail)` dispatches a bubbling `CustomEvent`.

## Template syntax

| Syntax | What it does |
| --- | --- |
| `Hello {expr}` | Text interpolation |
| `title="{expr}"`, `class="a {expr}"` | Attribute binding. If the element has a matching property (`value`, `checked`, `disabled`, or a component prop), the property is set and keeps its raw value, so you can pass objects and functions. |
| `onclick="{this.save}"` | Event handler. If the expression gives back a function, that function is called with the event. |
| `onclick="{this.state.n++}"` | Inline statement. `event` is available as a variable. |
| `onadd="{this.add}"` on a component | Sets the `onAdd` prop if the component has one. Otherwise it listens for the `add` event, which you can fire with `emit('add', …)`. |
| `<template each="{list}" as="item" index="i">` | Repeats its content for each item. A number `n` repeats it `n` times. |
| `<template if="{cond}">` … `<template else>` | Conditional rendering |
| `ref="name"` | Makes the element available as `name` in the expressions of this component and its parents/children. It's also in `this.refs.name`. |
| `<script type="text/candy">expr</script>` | Renders the HTML string that the expression returns (an array is joined). Add `function` to the tag to write a function body with `return`. |
| `\{` or `candy-ignore` | Escape a brace, or skip compiling a whole subtree |

Inside expressions, `this` is the nearest component. Names are looked up in this order: loop variables, then refs, then globals.

## Tests

```sh
npm test      # needs Playwright + Chromium
```

## Notes

- Expressions are evaluated with `new Function`, so templates must come from trusted sources, the same as inline `onclick` attributes. Don't put user-supplied HTML inside a `text/candy` script.
- `each` reuses rendered rows by index. If you remove an item from the middle, the rows after it receive new data instead of being moved.
