// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared constants for the session image element. Kept free of the component
// import so the Markdown renderer (and its tests) do not have to pull a .vue
// module into scope just to know the tag name.

export const SESSION_IMAGE_TAG = 'obelisk-session-image';

// Fired from inside the session image element (composed, so they cross the
// shadow boundary). The virtualized timeline uses them to tell real media
// growth apart from an estimate correction.
//
// Pending is announced when the element mounts with a source, not when the
// image loads: a decoder sizes an image from its header and grows the row well
// before the load event, so a row is only known to be settled once loading has
// actually finished.
export const SESSION_IMAGE_PENDING_EVENT = 'obelisk-session-image-pending';
export const SESSION_IMAGE_SETTLED_EVENT = 'obelisk-session-image-settled';
