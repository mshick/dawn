import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DocumentChipRail } from './document-chip-rail';
import type { ThreadDocument } from './use-thread-documents';

function doc(overrides: Partial<ThreadDocument> = {}): ThreadDocument {
  return {
    id: 'd1',
    name: 'spec.pdf',
    kind: 'pdf',
    byte_size: 12345,
    status: 'ready',
    error_code: null,
    error_message: null,
    created_at: '2026-05-12T00:00:00Z',
    ready_at: '2026-05-12T00:00:01Z',
    ...overrides,
  };
}

describe('DocumentChipRail detach UX', () => {
  it('renders a detach button per chip', () => {
    render(<DocumentChipRail documents={[doc()]} onDetach={vi.fn()} />);
    expect(screen.getByRole('button', { name: /detach spec\.pdf/i })).toBeInTheDocument();
  });

  it('opens a confirmation dialog when X is clicked', async () => {
    const user = userEvent.setup();
    render(<DocumentChipRail documents={[doc()]} onDetach={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/detach document/i)).toBeInTheDocument();
    expect(screen.getByText(/spec\.pdf/i)).toBeInTheDocument();
  });

  it('does not call onDetach when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onDetach = vi.fn();
    render(<DocumentChipRail documents={[doc()]} onDetach={onDetach} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onDetach).not.toHaveBeenCalled();
  });

  it('calls onDetach(id) when Detach is confirmed', async () => {
    const user = userEvent.setup();
    const onDetach = vi.fn().mockResolvedValue(undefined);
    render(<DocumentChipRail documents={[doc({ id: 'abc' })]} onDetach={onDetach} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    // Scope to the dialog so it can't collide with the chip's X button.
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^detach$/i }));
    expect(onDetach).toHaveBeenCalledWith('abc');
  });

  it('shows a spinner while onDetach is in-flight', async () => {
    const user = userEvent.setup();
    // `| undefined` (rather than `| null`) so a truthy check narrows the value
    // through the closure-assignment without needing a cast.
    let resolve: (() => void) | undefined;
    const onDetach = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    render(<DocumentChipRail documents={[doc()]} onDetach={onDetach} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^detach$/i }));
    expect(screen.getByTestId('chip-pending-d1')).toBeInTheDocument();
    resolve?.();
    await waitFor(() => expect(screen.queryByTestId('chip-pending-d1')).not.toBeInTheDocument());
  });

  it('keeps the chip and surfaces an error when onDetach rejects', async () => {
    const user = userEvent.setup();
    const onDetach = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    render(<DocumentChipRail documents={[doc()]} onDetach={onDetach} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^detach$/i }));
    // The rail catches the rejection and renders an inline error. The chip is
    // unaffected — the hook owns the optimistic state, the rail just reflects
    // it. The spinner clears when the promise settles.
    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeInTheDocument());
    expect(screen.queryByTestId('chip-pending-d1')).not.toBeInTheDocument();
    expect(screen.getByText(/spec\.pdf/)).toBeInTheDocument();
  });
});
