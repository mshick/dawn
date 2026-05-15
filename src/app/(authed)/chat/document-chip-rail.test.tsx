import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DocumentChipRail } from './document-chip-rail';
import type { ChipDocument, ThreadDocument } from './use-thread-documents';

function serverDoc(overrides: Partial<ThreadDocument> = {}): ChipDocument {
  return {
    source: 'server',
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

function pendingChip(overrides: Partial<{ name: string; clientId: string }> = {}): ChipDocument {
  const clientId = overrides.clientId ?? 'c-pending-1';
  return {
    source: 'pending',
    clientId,
    id: clientId,
    name: overrides.name ?? 'uploading.pdf',
    byte_size: 1024,
    status: 'pending',
    created_at: '2026-05-12T00:00:00Z',
  };
}

function rejectedChip(
  overrides: Partial<{ name: string; clientId: string; error_code: string }> = {},
): ChipDocument {
  const clientId = overrides.clientId ?? 'c-rejected-1';
  return {
    source: 'rejected',
    clientId,
    id: clientId,
    name: overrides.name ?? 'oversize.pdf',
    byte_size: 26 * 1024 * 1024,
    status: 'failed',
    error_code: overrides.error_code ?? 'too_large',
    error_message: null,
    created_at: '2026-05-12T00:00:00Z',
  };
}

describe('DocumentChipRail server chip detach UX', () => {
  it('renders a detach button per chip', () => {
    render(<DocumentChipRail documents={[serverDoc()]} onDismiss={vi.fn()} />);
    expect(screen.getByRole('button', { name: /detach spec\.pdf/i })).toBeInTheDocument();
  });

  it('opens a confirmation dialog for server-backed chips', async () => {
    const user = userEvent.setup();
    render(<DocumentChipRail documents={[serverDoc()]} onDismiss={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/detach document/i)).toBeInTheDocument();
  });

  it('does not call onDismiss when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<DocumentChipRail documents={[serverDoc()]} onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('calls onDismiss(id) when Detach is confirmed', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    render(<DocumentChipRail documents={[serverDoc({ id: 'abc' })]} onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^detach$/i }));
    expect(onDismiss).toHaveBeenCalledWith('abc');
  });

  it('shows a spinner while onDismiss is in-flight', async () => {
    const user = userEvent.setup();
    let resolve: (() => void) | undefined;
    const onDismiss = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    render(<DocumentChipRail documents={[serverDoc()]} onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^detach$/i }));
    expect(screen.getByTestId('chip-pending-d1')).toBeInTheDocument();
    resolve?.();
    await waitFor(() => expect(screen.queryByTestId('chip-pending-d1')).not.toBeInTheDocument());
  });

  it('keeps the chip and surfaces an error when onDismiss rejects', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    render(<DocumentChipRail documents={[serverDoc()]} onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: /detach spec\.pdf/i }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^detach$/i }));
    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeInTheDocument());
    expect(screen.queryByTestId('chip-pending-d1')).not.toBeInTheDocument();
    expect(screen.getByText(/spec\.pdf/)).toBeInTheDocument();
  });
});

describe('DocumentChipRail pending and rejected chips', () => {
  it('renders a pending chip with a spinner and no X button', () => {
    render(<DocumentChipRail documents={[pendingChip()]} onDismiss={vi.fn()} />);
    expect(screen.getByText(/uploading\.pdf/)).toBeInTheDocument();
    // No detach control while in-flight.
    expect(
      screen.queryByRole('button', { name: /detach uploading\.pdf/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the friendly message for a rejected (oversize) chip', () => {
    render(<DocumentChipRail documents={[rejectedChip()]} onDismiss={vi.fn()} />);
    expect(screen.getByText(/Files must be 25 MB or smaller\./)).toBeInTheDocument();
  });

  it('renders the friendly message for an unsupported_type rejection', () => {
    render(
      <DocumentChipRail
        documents={[rejectedChip({ error_code: 'unsupported_type', name: 'cat.png' })]}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Unsupported file type — try PDF, DOCX, Markdown, or plain text\./),
    ).toBeInTheDocument();
  });

  it('renders the friendly message for a server-side pipeline failure', () => {
    render(
      <DocumentChipRail
        documents={[
          serverDoc({
            status: 'failed',
            error_code: 'extract_empty',
            error_message: 'raw underlying message',
          }),
        ]}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Couldn't extract any text — the file may be scanned or empty\./),
    ).toBeInTheDocument();
  });

  it('dismisses a rejected chip without a confirmation dialog', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    render(
      <DocumentChipRail documents={[rejectedChip({ clientId: 'c-1' })]} onDismiss={onDismiss} />,
    );
    await user.click(screen.getByRole('button', { name: /detach oversize\.pdf/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('c-1'));
  });
});
