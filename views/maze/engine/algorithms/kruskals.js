export function kruskals(grid, prng) {
  grid.reset();
  // Union-Find
  const parent = grid.cells.map((_, i) => i);
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { parent[find(a)] = find(b); }

  // Collect all unique edges
  const edges = [];
  grid.cells.forEach(cell => {
    grid.neighbors(cell).forEach(({ cell: nb, dir }) => {
      if (nb.id > cell.id) edges.push({ a: cell, b: nb, dir });
    });
  });
  prng.shuffle(edges);

  edges.forEach(({ a, b, dir }) => {
    if (find(a.id) !== find(b.id)) {
      grid.carve(a, b, dir);
      union(a.id, b.id);
    }
  });
  return grid;
}
