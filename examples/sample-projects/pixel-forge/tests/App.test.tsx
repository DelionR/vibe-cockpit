import { render, screen } from '@testing-library/react';
import { App } from '../src/App.js';

test('renders title', () => {
  render(<App />);
  expect(screen.getByText('Pixel Forge')).toBeTruthy();
});
