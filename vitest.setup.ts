import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';

// Make getByText / getAllByText respect aria-hidden so that Radix UI dialog
// backdrop (which Radix marks aria-hidden when a modal opens) does not cause
// false "multiple elements found" errors.
configure({ defaultIgnore: 'script, style, [aria-hidden="true"] *' });
