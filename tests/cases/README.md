# Test cases

Each case references a **catalog by name** (the environment it needs) and a
sequence of AAP operations plus assertions (ARCHITECTURE.md §9/§10).

> **Status: placeholder.** The case format is not fixed yet. Two canonical
> bring-up cases to author first (real plugin, not `aappluginsample`):
>
> - **MDA DX10** — send a note, render ~2s → golden. Exercises instancing, MIDI,
>   preset selection, parameters, instrument state. (no audio input)
> - **MDA Overdrive** — feed a short input WAV, render → golden. Exercises the
>   audio-input path + a parameter's audible effect on a known signal.
>
> Default execution is an instrumented test (path A); the JS controller (path B)
> is optional per case.
