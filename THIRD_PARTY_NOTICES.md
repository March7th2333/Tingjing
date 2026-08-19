# Third-Party Notices

Tingjing source code is licensed under AGPL-3.0-only except where a file or asset states otherwise. Dependencies and third-party brands remain under their own licenses and terms.

## Direct JavaScript dependencies

- React and React DOM — MIT License.
- Tauri JavaScript API and CLI — Apache-2.0 OR MIT.
- qrc-decoder — MIT License.

Exact versions and transitive dependencies are recorded in `package-lock.json`. Installed package distributions contain their corresponding license files.

## Direct Rust dependencies

The Rust application uses Tauri, Tokio, reqwest, rustls, serde, qrcode, base64, sha2, and other crates under permissive or compatible licenses recorded by Cargo. Some transitive crates use MPL-2.0; their source remains separately licensed under MPL-2.0. Exact versions are recorded in `src-tauri/Cargo.lock`.

`netease-music` 0.1.1 is distributed with an upstream `LICENSE.md` containing the MIT permission text and the copyright notice `Copyright (c) 2011-2017 GitHub Inc.` This notice is reproduced here because it is the license file shipped by that crate; Tingjing does not claim authorship of that dependency.

## Spotify assets and trademarks

Files under `public/spotify/` are Spotify brand assets used to identify an integration with Spotify. They are not licensed under Tingjing's AGPL license. Spotify and the Spotify logo are trademarks of Spotify AB. Use must comply with Spotify's branding and developer terms.

## Provider names, media, and user content

QQ Music, NetEase Cloud Music, Spotify, their names, logos, services, and content belong to their respective owners. Tingjing is not endorsed by or affiliated with those services unless explicitly stated by them.

Songs, lyrics, cover artwork, playlists, avatars, and other account content fetched at runtime are not part of this repository and are not covered by Tingjing's source-code license. Users and downstream distributors are responsible for obtaining all rights required for their use and distribution.
