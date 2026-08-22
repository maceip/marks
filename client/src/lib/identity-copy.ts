/** Honest product copy for identity chrome. Shared by every shell. */

export type DocumentRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export const ROLE_COPY: Record<DocumentRole, { label: string; detail: string }> = {
  owner: {
    label: 'Owner',
    detail: 'Can share, delete, and change who has access. This role cannot be granted to someone else.',
  },
  editor: {
    label: 'Can edit',
    detail: 'Can change the source. Cannot share or delete the page.',
  },
  commenter: {
    label: 'Can comment',
    detail: 'Can review. Cannot change the source.',
  },
  viewer: {
    label: 'Can view',
    detail: 'Can read the preview. Cannot change or comment.',
  },
};

export const SCRATCH_UPGRADE_LINE =
  'This workspace is temporary. Scan with your phone to keep it and use it on other devices.';

export const SCRATCH_HONEST_LINE =
  'Closing this tab before you keep it is unrecoverable. Scratch is a temporary capability, not a named account.';

export const SCRATCH_LOCAL_LINE =
  'This build keeps the page in this browser. The phone QR is the pairing shape the service will fill. No invitation is sent.';

export const SHARE_LOCAL_LINE =
  'Access is staged in the interface. Scratch cannot share. Owner cannot be granted.';
