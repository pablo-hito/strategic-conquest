# Strategic Conquest: Modern Multiplayer Protocol — Arquitectura

## 1. Decisiones base

| Decisión | Elección | Por qué |
|---|---|---|
| Lenguaje | TypeScript en todo el stack | Un solo modelo de dominio compartido por servidor, cliente e IA |
| Repo | Monorepo npm workspaces | `packages/core` hoy; `server`, `client`, `ai`, `protocol` después |
| Autoridad | Servidor autoritativo | El cliente envía *intenciones*; el servidor valida con `core` y devuelve deltas |
| Dominio | `@sc/core` puro: sin I/O, sin red, sin DOM, sin tiempo real | Testeable, determinista, reutilizable por bots y por el replay |
| Grilla | Cuadrada de 8 direcciones (como el original), detrás de `GridTopology` | Se puede sumar hex sin tocar visión, movimiento ni IA |
| Estado | Entidades con estado JSON-serializable (`toSnapshot`/`fromSnapshot`) | Persistencia, reconexión y deltas por WebSocket sin mapeos extra |

```
packages/
  core/      ← (este paso) dominio puro: grilla, terreno, unidades, ciudades, niebla
  protocol/  ← (fase 2) mensajes cliente↔servidor tipados (zod), versionado
  server/    ← (fase 2) Fastify + ws, salas, turnos, timers, persistencia (Postgres/Redis)
  ai/        ← (fase 2+) bots de reemplazo; consumen PlayerView, igual que un humano
  client/    ← (fase 4) Vite + React (UI) + PixiJS (mapa), Zustand/XState
```

### Bounded contexts (DDD)
- **Match / Board** (`core`): reglas del juego. Agregados: `Unit`, `City`; `WorldState` es la raíz que mantiene los índices espaciales consistentes.
- **Visibility** (`core/visibility`): servicio de dominio que calcula lo que ve un jugador y su memoria (`PlayerFogMap`).
- **Lobby / Session** (`server`): salas, jugadores, reconexión, reloj. No conoce reglas.
- **Presentation** (`client`): sólo ve `PlayerView`; nunca el `WorldState` completo.

## 2. Modelo de dominio (implementado)

```
src/
  shared/      ids con marca (PlayerId/UnitId/CityId), Result<T,E>, invariant
  grid/        Coord, Terrain (tabla de datos), GridTopology (Square8), Grid
  units/       UnitTypeDef (catálogo de 18 unidades), Unit (entidad)
  cities/      CitySpecialization, City (entidad, producción)
  world/       WorldState (raíz: entidades + índices tile→units, tile→city)
  visibility/  line-of-sight, vision, fog-of-war (PlayerFogMap), player-view
```

**Terreno como datos.** Cada terreno define dominio, elevación, *canopy*, bonus de visión, ocultamiento aéreo, bonus defensivo y costo de movimiento **por clase de movimiento** (`foot`, `wheeled`, `tracked`, `naval`, `naval_heavy`, `air`). Agregar una unidad no requiere tocar la tabla de terreno.

**Regla de paso mínimo.** Una unidad con todos sus MP siempre puede dar un paso a terreno transitable aunque cueste más (si no, la infantería de 1 MP nunca subiría una colina).

**Errores.** Las violaciones de reglas (comandos del jugador) devuelven `Result` con un código estable (`REQUIRES_COAST`, `CARGO_FULL`…), localizable en el cliente. Las excepciones quedan para invariantes rotos (bugs).

## 3. Niebla de guerra y línea de visión

**Tres estados por casilla:** `Unexplored` (negro) → `Visible` ↔ `Fogged` (gris, con el dueño de ciudad *según se vio por última vez*). Nunca se vuelve a `Unexplored`.

**Línea de visión (height-field).** Altura del ojo = elevación del suelo + `eyeHeight` (tierra/mar 0.5, aire 6, AWACS 10, ciudad 1). Se traza la recta hasta la *cima* del objetivo (elevación + canopy); cualquier casilla intermedia cuya altura de obstrucción alcance la recta la bloquea. Resultado:
- Bosques y colinas bloquean la vista terrestre detrás de ellos, pero se ven a sí mismos.
- Desde colinas/montañas se mira por encima del bosque (y se gana +1/+2 de rango).
- Los aviones sólo son bloqueados por montañas inmediatamente delante del objetivo.
- Se trazan ambas direcciones y basta una libre: **LOS simétrica** (si A ve a B, B ve a A).

**Detección (encima de la visibilidad de la casilla):**
- Submarino en *Silent Running*: sólo por adyacencia o dentro del radio de sonar (sin LOS, también en niebla).
- Unidad terrestre en bosque: invisible para aviones no adyacentes; las unidades de superficie la ven normalmente.
- La carga nunca es visible; un transporte no revela lo que lleva, y las unidades embarcadas no ven.
- Visión compartida entre aliados (`update(world, allies)`).

**Memoria y deltas.** `PlayerFogMap.update()` devuelve un `FogUpdate` (`revealed`, `hidden`, `unitsSpotted`, `unitsLost`, `citiesUpdated`): es exactamente el delta a empujar por WebSocket. Guarda "fantasmas" de enemigos en su última posición conocida, que se borran cuando esa casilla vuelve a verse vacía. Se recalcula tras **cada** acción que cambia la visión (no sólo al fin de turno), para que el servidor pueda detener un movimiento al hacer contacto.

**Anti-cheat.** `buildPlayerView()` es la única representación que sale del servidor: terreno inexplorado = `255`, enemigos sin carga/combustible/órdenes, ciudades ajenas sólo con el dueño recordado.

## 4. Valores iniciales de balance (tunables)

| Unidad | Clase mov. | MP | Visión | HP | Atk/Def | Turnos | Notas |
|---|---|---|---|---|---|---|---|
| Recon | wheeled | 3 | 3 | 6 | 1/1 | 3 | |
| Infantry | foot | 1 | 1 | 10 | 2/2 | 4 | captura, atrinchera (+20%/turno, máx. +60%) |
| Mech Infantry | tracked | 2 | 1 | 10 | 3/3 | 6 | captura, atrinchera |
| Heavy Tank | tracked | 2 | 1 | 12 | 6/4 | 8 | |
| Artillery | tracked | 1 | 1 | 8 | 6/1 | 8 | rango 2–3, no mueve tras disparar |
| Anti-Air | wheeled | 2 | 2 | 8 | 2/2 | 6 | intercepta a 2 |
| Corvette | naval | 5 | 2 | 6 | 2/2 | 5 | |
| Destroyer | naval | 4 | 2 | 10 | 4/3 | 10 | sonar 2 |
| Missile Cruiser | naval_heavy | 3 | 3 | 14 | 6/5 | 16 | rango 1–4, AA 3, Naval Yard |
| Submarine | naval | 3 | 1 | 8 | 7/2 | 12 | Silent Running: sigilo, ½ MP |
| Battleship | naval_heavy | 3 | 2 | 20 | 8/7 | 20 | rango 1–3, Naval Yard |
| Carrier | naval_heavy | 3 | 2 | 16 | 1/4 | 20 | 3 aéreos, Naval Yard |
| Transport | naval | 3 | 2 | 8 | 0/1 | 8 | 3 terrestres |
| Recon Drone | air | 10 | 4 | 3 | 0/0 | 4 | combustible 30 |
| Fighter | air | 10 | 2 | 8 | 5/4 | 8 | combustible 20 |
| CAS | air | 8 | 2 | 8 | 7/2 | 10 | combustible 16 |
| Strategic Bomber | air | 6 | 2 | 12 | 8/2 | 15 | combustible 30, Air Base |
| AWACS | air | 6 | 8 | 6 | 0/1 | 14 | ojo 10, Air Base |

Especializaciones: *Industrial Hub* (−25% turnos para blindados/artillería/AA/mecanizada), *Naval Yard* (requiere costa; habilita buques capitales), *Air Base* (−20% cazas/CAS, 10 hangares, habilita bombardero/AWACS). Bombardeo estratégico: progreso a la mitad y puerto cerrado 2 turnos (los barcos en producción se detienen sin perder progreso). Capturar una ciudad reinicia la producción (infantería) y conserva la especialización.

## 5. Próximos pasos (Fase 1, continuación)
1. `MovementService`: validación de pasos (adyacencia, terreno, apilamiento, ZOC), pathfinding A* con costos por clase, alcance (Dijkstra) para el overlay de movimiento, interrupción al contacto.
2. Captura de ciudades y embarque/desembarco anfibio sobre `WorldState`.
3. Ciclo de turno: `startTurn` de unidades, producción, combustible (aterrizaje o derribo), suministro.
4. Generador de mapas (Simplex + reparto equitativo de ciudades) con semilla reproducible.

Pendientes de diseño anotados: los IDs secuenciales filtran cuántas unidades produjo un rival; antes de la Fase 2 conviene usar IDs opacos por observador en `PlayerView`.
