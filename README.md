# Strategic Conquest: Modern Multiplayer Protocol

Remake moderno y multijugador (2–6 jugadores) del clásico de estrategia por turnos de Macintosh.

- `packages/core`: modelo de dominio puro en TypeScript (grilla, terreno, unidades, ciudades, niebla de guerra, movimiento, captura, ciclo de turno y generador de mapas).
- `packages/client`: visor jugable en Canvas 2D. Partida local por turnos (hot-seat) para 2 a 6 jugadores; cada uno ve sólo su propia niebla de guerra.

Ver [ARCHITECTURE.md](ARCHITECTURE.md) para las decisiones de diseño y la hoja de ruta.

```bash
npm install
npm test
```

Para jugar en local:

```bash
npm run dev -w @sc/client
```

Para generar una versión de un solo archivo (`packages/client/dist/strategic-conquest.html`), que se abre directamente en el navegador:

```bash
npm run build -w @sc/client
```
