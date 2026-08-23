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

/** Single-device keep: the phone-only visitor has nothing to scan with. */
export const SELF_KEEP_PHONE_LINE =
  'This workspace is temporary. Keep it on this phone: its key becomes the account key, and this phone approves any device you add later.';

export const SELF_KEEP_DEVICE_LINE =
  'No phone with you? Keep the workspace on this device only. Its key becomes the account key until you link another device.';

export const SELF_KEEP_HONEST_LINE =
  'One device means one key. Lose this device and its browser data before linking another, and the documents are unrecoverable.';

export const SELF_KEEP_OTHER_DEVICE_LINE =
  'Already keep documents on another device? Link instead — keeping here starts a separate workspace, and workspaces never merge on their own.';

export const SELF_KEEP_LOCAL_LINE =
  'This build keeps the page in this browser. The service turns this button into a real account key on this device.';

export const SHARE_LOCAL_LINE =
  'Access is staged in the interface. Scratch cannot share. Owner cannot be granted.';

export const SHARE_GRANT_LINE =
  'Grant editor, commenter, or viewer to a Marks principal. Link redeem needs a live session.';

export const PAIRING_STEPS = [
  {
    title: 'Bind this browser',
    detail: 'A pending device key is bound once. Generating the key does not keep the workspace.',
  },
  {
    title: 'Mint the pairing',
    detail: 'The service returns a two-minute URL and four words. Only that URL belongs in the QR.',
  },
  {
    title: 'Phone confirms',
    detail: 'Scan the QR or type the four words. A guessed pairing id is authentication failed.',
  },
  {
    title: 'Finalize this tab',
    detail: 'Scratch is claimed, the cookie lands, and reconnect uses a principal ticket.',
  },
] as const;

export const RETURN_VISIT_STEPS = [
  {
    title: 'Session cookie',
    detail: 'Ordinary return visits use a rotating HTTP-only cookie. No presence prompt.',
  },
  {
    title: 'Silent device redeem',
    detail: 'If the cookie is gone, this browser signs a one-use challenge with its device key.',
  },
  {
    title: 'Scratch',
    detail: 'If there is no enrolled key, the tab is a new temporary workspace.',
  },
] as const;

export const RECONNECT_LINE =
  'Reconnect mints a new one-use ticket and keeps this document site. Tickets never go in the URL.';

export const LOGOUT_LOCAL_LINE =
  'There is no live session cookie to revoke on this tab.';

export const REVOKE_LOCAL_LINE =
  'Revoke needs a phone controller session and a CSRF token kept only in memory.';

export const LINK_TTL_OPTIONS = [
  { id: '2m', label: '2 minutes', detail: 'Pairing-shaped short grant' },
  { id: '1h', label: '1 hour', detail: 'A working session' },
  { id: '1d', label: '1 day', detail: 'A day of access' },
] as const;
