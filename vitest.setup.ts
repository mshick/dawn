import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';

// Make getByText / getAllByText respect aria-hidden so that Radix UI's open
// dialog (which hides the rest of the page with aria-hidden to trap focus)
// doesn't cause false "multiple elements found" errors.
configure({ defaultIgnore: 'script, style, [aria-hidden="true"] *' });
