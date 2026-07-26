# Third-party assets

Every asset in `assets/` came from [Poly Haven](https://polyhaven.com) and is
released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/),
which places it in the public domain. No attribution is legally required;
it is recorded here because crediting the people whose work makes this look
like a game rather than a grey box is the decent thing to do.

Regenerate with `node tools/fetch-assets.mjs`.

| Asset | Kind | Author(s) | Source |
| --- | --- | --- | --- |
| Wasteland Clouds (Pure Sky) | HDRI | Jarod Guest, Sergej Majboroda | https://polyhaven.com/a/wasteland_clouds_puresky |
| Sand 02 | Texture | Charlotte Baglioni | https://polyhaven.com/a/sand_02 |
| Rusty Metal 02 | Texture | Rob Tuytel | https://polyhaven.com/a/rusty_metal_02 |
| Metal Plate | Texture | Rob Tuytel | https://polyhaven.com/a/metal_plate |
| Rust Coarse 01 | Texture | Dimitrios Savva, Rico Cilliers | https://polyhaven.com/a/rust_coarse_01 |
| Corrugated Iron | Texture | Jenelle van Heerden, Dimitrios Savva | https://polyhaven.com/a/corrugated_iron |
| Metal Grate Rusty | Texture | Rob Tuytel, Dimitrios Savva | https://polyhaven.com/a/metal_grate_rusty |
| Rock Boulder Dry | Texture | Dimitrios Savva, Rico Cilliers | https://polyhaven.com/a/rock_boulder_dry |
| Concrete Wall 007 | Texture | Dario Barresi, Rico Cilliers, Charlotte Baglioni | https://polyhaven.com/a/concrete_wall_007 |

## Everything else

All geometry, shaders, procedural textures and audio in this project are
generated in code. There are no imported meshes: the fortress, the horde and
the terrain are all built at runtime, which is why the whole build is a few
hundred kilobytes of source plus the textures above.
