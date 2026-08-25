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
  'This page is already saved and public. Log in with your phone to use your account on this browser.';

export const SCRATCH_HONEST_LINE =
  'Anyone with this page URL can edit it. Closing the tab does not erase the page; log in before closing if you want to keep its account controls.';

export const SCRATCH_LOCAL_LINE =
  'This build keeps the page in this browser. A connected service would put a secure login link in the QR code.';

/** A phone visitor needs a second screen to complete the supported login. */
export const SELF_KEEP_PHONE_LINE =
  'Open this same page on a laptop, choose Log In, then scan the QR code with this phone.';

export const SELF_KEEP_DEVICE_LINE =
  'Cannot use a phone? You can log in on this browser only.';

export const SELF_KEEP_HONEST_LINE =
  'If you lose this browser before logging in on another device, account access cannot be recovered. Public pages remain available at their URLs.';

export const SELF_KEEP_OTHER_DEVICE_LINE =
  'Already use Marks elsewhere? Open this public page there and choose Log In.';

export const SELF_KEEP_LOCAL_LINE =
  'This build keeps the page in this browser. A connected service would log in this browser.';

export const SHARE_LOCAL_LINE =
  'Anonymous pages already grant editor access to anyone with the opaque page URL. Owner cannot be granted.';

export const SHARE_GRANT_LINE =
  'Grant editor, commenter, or viewer access to a Marks account.';

export const PAIRING_STEPS = [
  {
    title: 'Scan with your phone',
    detail: 'Scan the QR code, or enter the four-word login code on your phone.',
  },
  {
    title: 'Approve the login',
    detail: 'Your phone confirms that this browser can use your account.',
  },
  {
    title: 'Return to this browser',
    detail: 'This dialog closes after the browser is logged in.',
  },
] as const;

export const RETURN_VISIT_STEPS = [
  {
    title: 'Return normally',
    detail: 'This browser keeps you logged in between visits.',
  },
  {
    title: 'Recover automatically',
    detail: 'If the login expires, this browser can securely restore it.',
  },
  {
    title: 'Continue without login',
    detail: 'If this browser is not logged in, it opens a new saved public page.',
  },
] as const;

export const LOGOUT_LOCAL_LINE =
  'There is no live session cookie to revoke on this tab.';

export const REVOKE_LOCAL_LINE =
  'Removing a device requires a logged-in account.';

export const LINK_TTL_OPTIONS = [
  { id: '2m', label: '2 minutes', detail: 'Short-lived access' },
  { id: '1h', label: '1 hour', detail: 'A working session' },
  { id: '1d', label: '1 day', detail: 'A day of access' },
] as const;
