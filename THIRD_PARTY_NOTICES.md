# Third-party notices

The PJLink protocol (`src/pjlink/`) is written from the public PJLink
specification (JBMIA, class 1 and class 2), and cross-checked with the
following project: its greeting and authentication sequence (the MD5 digest
of the random number and the password, sent before the first command only,
`PJLINK ERRA` on a wrong one), its line format (`%1BODY param`, answers up to
CR, `ERR1` to `ERR4`), and the values of `POWR`, `INPT`, `AVMT`, `ERST`,
`LAMP`, `INST`, `NAME`, `INF1`, `INF2` and `CLSS` (`pypjlink/protocol.py`,
`pypjlink/projector.py`). No code of it is copied as is and nothing of it is
installed at runtime; its license is reproduced below.

## pypjlink2 1.2.2

<https://github.com/benoitlouy/pypjlink> by Peter Ward, Gaetano Guerriero
and Benoit Louy (the library behind the Home Assistant PJLink integration),
version 1.2.2 (PyPI, 2020-06-14), repository read at commit `c96c6ed` of
2020-06-13. Licensed under the Apache License, Version 2.0; its LICENSE file
is the standard text, without a NOTICE file:

```
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

The full text of the Apache License, Version 2.0 is in this repository's
`LICENSE` file, shipped in the Docker image with this notice.

## Test kit (tests only)

`test/kit/` is copied from the maintainer's own Gladys test kit
(Apache-2.0, same author): fake TCP devices and clocks. It is not part of the
Docker image.
