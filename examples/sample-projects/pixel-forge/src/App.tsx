import { useState } from 'react';

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Pixel Forge</h1>
      <p>Счётчик: {count}</p>
      <button onClick={() => setCount((c) => c + 1)}>Увеличить</button>
    </main>
  );
}
