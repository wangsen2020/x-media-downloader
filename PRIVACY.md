# Privacy Policy — X Media Downloader

**Last updated: 20 September 2026**

## Short version

X Media Downloader collects nothing, transmits nothing, and has no servers.
Everything it stores stays in your own browser profile on your own computer.

## What the extension stores locally

Two things are written to `chrome.storage.local`, which lives on your machine
and is readable only by this extension:

1. **Your settings** — preferred video quality, destination subfolder,
   filename template, whether to show Chrome's "Save As" dialog, and whether
   to show the download button inside the page.
2. **Your download history** — for each file you chose to download: the
   account handle, the post URL, the media type and quality, the file size,
   the filename, and the time. This exists so the options page can show you
   what you have saved and let you re-download or reveal a file later.

A short-lived cache of media URLs for the current browsing session is kept in
`chrome.storage.session`, which Chrome clears when the browser closes.

You can delete all of this at any time from the extension's options page
("Clear all"), or by removing the extension.

## What the extension does not do

- It does **not** collect, transmit, sell, or share any user data.
- It does **not** contain analytics, telemetry, tracking pixels, or crash
  reporting.
- It does **not** have a backend server, and it sends nothing to the author.
- It does **not** read, store, or transmit your X credentials, cookies,
  direct messages, or the contents of your timeline.
- It does **not** execute remote code. All JavaScript is contained in the
  published package.

## Network requests

The extension makes network requests to exactly two places, and only when you
ask it to download something:

- **`video.twimg.com` / `pbs.twimg.com`** — X's own media servers, to fetch
  the video or image file you asked to save. This is performed by Chrome's
  downloads API.
- **`cdn.syndication.twimg.com`** — X's public endpoint for embedded posts,
  used only as a fallback to look up the available video renditions for a
  single post when the page's own response was not observed. Only the post ID
  is sent.

No request is ever made to any server operated by the author or by any third
party.

## Permissions and why they exist

| Permission | Why |
| --- | --- |
| `downloads` | To save the file you selected, and to report its progress and completion into the local history. |
| `storage` | To keep your settings and your local download history. |
| Host access to `x.com` / `twitter.com` | So the content script can run on the page, find posts containing media, and add the download button. |
| Host access to `cdn.syndication.twimg.com` | The fallback described above for resolving a post's video renditions. |

## Children

The extension is a general-purpose utility and is not directed at children.

## Changes

Any change to this policy will be committed to this repository, so the full
history is publicly auditable.

## Contact

Open an issue at
<https://github.com/wangsen2020/x-media-downloader/issues>.

## Source

This extension is open source under the MIT licence. Every claim above can be
verified by reading the code:
<https://github.com/wangsen2020/x-media-downloader>
