# Strategic Conquest: Modern Multiplayer Protocol

Remake moderno y multijugador (2–6 jugadores) del clásico de estrategia por turnos de Macintosh.

- `packages/core`: modelo de dominio puro en TypeScript (grilla, terreno, unidades, ciudades, niebla de guerra, movimiento, captura, ciclo de turno y generador de mapas).
- `packages/ai`: bots que juegan usando sólo su propia niebla de guerra: el estratégico (cuatro personalidades) y el anterior, como referencia.
- `packages/client`: visor jugable en Canvas 2D, contra la computadora (con dificultad Normal, Difícil o Brutal) o entre humanos en la misma pantalla (2 a 6 jugadores); cada uno ve sólo su propia niebla de guerra. También juega en línea contra un servidor.
- `packages/protocol`: mensajes cliente↔servidor validados y diferencias de vista por jugador.
- `packages/server`: servidor de partidas en línea (salas con código, reloj de turno, reconexión, relevo por bots y persistencia).

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

## Jugar en línea

Compilar y arrancar el servidor (sirve el juego en `http://localhost:8080`):

```bash
npm run build
```

```bash
PORT=8080 DATA_DIR=./data npm start
```

En el navegador: **Nueva partida → En línea → Crear sala**, y compartir el enlace (`?sala=CODIGO`) con los demás. Variables: `PORT` (8080), `DATA_DIR` (`./data`, donde se guardan las partidas), `GRACE_MS` (20000, espera antes de que un bot tome el asiento de alguien desconectado).

Con Docker (sirve en Fly.io, Render, Railway o cualquier VPS; montar un volumen en `/data` para que las partidas sobrevivan a los reinicios):

```bash
docker build -t strategic-conquest .
```

```bash
docker run -p 8080:8080 -v sc-data:/data strategic-conquest
```

Detrás de un proxy con HTTPS el cliente usa `wss://` automáticamente. El servidor guarda las salas en memoria y en disco: hay que correr **una sola instancia**.
