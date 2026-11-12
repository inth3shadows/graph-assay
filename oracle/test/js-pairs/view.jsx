function Item(i) { return i; }

function View() {}

View.prototype.render = function render(items) {
  return <ul>{items.map((i) => <li key={i}>{Item(i)}</li>)}</ul>;
};

module.exports = View;
