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
  movement/    reglas de paso, búsqueda de caminos, alcance, ejecución de movimientos
  match/       Match (orquestador de turnos y comandos), reglas de turno, victoria
  mapgen/      generador procedural de archipiélagos (simplex + RNG con semilla)
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

## 3b. Movimiento

**Qué sabe el que planifica (`MapKnowledge`).** Las reglas de movimiento consultan el mapa a través de una interfaz con dos implementaciones:
- `truthKnowledge(world)`: la verdad. La usa el servidor al ejecutar y validar.
- `fogKnowledge(world, fog)`: sólo lo que conoce el jugador. La usan los caminos, el overlay de alcance y los bots. Las casillas sin explorar se suponen transitables (costo 1) y los enemigos no detectados no existen, así planificar no filtra información.

**Reglas de un paso (`checkStep`).** Adyacencia, límites, combustible, costo de terreno por clase de movimiento, enemigos en la casilla (eso es un ataque, no un movimiento) y ciudades ajenas: sólo infantería y mecanizada pueden entrar, y eso es una captura (ver 3c). Los barcos atracan en ciudades costeras propias. La tropa terrestre que pisa agua con un transporte propio con lugar *embarca* (y termina su movimiento); la que baja del transporte a tierra *desembarca*. En ciudades propias se mueve a costo 1 (rutas). Se permite apilar unidades propias sin límite por ahora.

**Caminos multi-turno (`findPath`, A\*) y alcance (`reachableThisTurn`, Dijkstra).** El costo no es una suma simple por la regla de paso mínimo, así que el estado es *(turno, MP gastados en el turno)* ordenado por `g = turno·MP + gastados`. Un `g` menor siempre domina, por eso la búsqueda sigue siendo óptima: minimiza turnos y, a igualdad, deja más MP. Cada paso indica en qué turno se da (para dibujar marcadores de turno). Los aviones quedan limitados por el combustible.

**Ejecución (`moveUnit`).** El cliente manda un camino; el servidor revalida cada paso contra la verdad, recalcula la niebla de **todos** los jugadores después de cada paso y se detiene:
- `CONTACT`: apareció un enemigo nuevo (el jugador puede reaccionar con los MP que le quedan);
- `BLOCKED`: algo oculto en la niebla cortó el camino;
- `CAPTURED`, `BOARDED`, `NO_MOVES_LEFT`, `CRASHED` (avión sin combustible fuera de una ciudad o portaaviones propio), o `COMPLETED`.

Sólo el primer paso puede rechazar el comando entero; a partir de ahí la unidad se detiene donde está. Los aviones repostan al pasar por una ciudad propia o un portaaviones propio con lugar. Devuelve los deltas de niebla de cada jugador ya combinados (`mergeFogUpdates`), listos para enviar.

## 3c. Captura y victoria

**Captura = entrar.** Una unidad con `canCaptureCities` (infantería, mecanizada) que entra a una ciudad neutral o enemiga *sin defensores* la captura, y eso termina su turno. Si hay defensores, primero hay que eliminarlos (combate, Fase 3). Vale el asalto anfibio: la infantería puede capturar directamente desde un transporte adyacente. Al capturar, la producción se reinicia (infantería) y la especialización se conserva. La niebla se recalcula en el acto: el nuevo dueño gana la visión de la ciudad y el anterior la pierde, *sin enterarse del cambio de dueño* si no tiene otra forma de ver la ciudad. En los caminos, una ciudad ajena conocida es un destino válido pero también un final de recorrido.

**Victoria (`evaluateVictory`).** Se evalúa después de cada captura o pérdida de unidades y al cerrar cada turno:
- gana quien posea la proporción configurada de **todas** las ciudades del mapa, neutrales incluidas (`cityShareToWin`, 0.75 por defecto, 1 = conquista total);
- queda eliminado quien no tenga ciudades **ni** unidades capaces de capturar (incluidas las embarcadas), porque ya no puede producir ni recuperarse;
- si queda un solo jugador, gana por `last_standing`. Si todos caen a la vez no hay ganador (empate).

## 3d. Ciclo de turno (modo clásico secuencial)

**`Match` es la puerta de entrada de los comandos** (`move`, `setProduction`, `setSpecialization`, `endTurn`): valida que sea el turno de quien lo pide, delega en las reglas, mantiene al día la niebla de todos y reevalúa la victoria. Timers, sockets y persistencia quedan afuera (servidor, Fase 2). El modo simultáneo (WEGO) será otro orquestador sobre las mismas reglas.

**Inicio del turno de un jugador (`beginPlayerTurn`):**
1. Sus ciudades producen; la unidad nueva aparece en la ciudad y puede moverse ese mismo turno.
2. Sus unidades recuperan MP y, si no se movieron, suben un nivel de atrincheramiento.
3. Reparación y combustible: en ciudad propia +2 HP y tanque lleno; aviones dentro de un portaaviones +1 HP y tanque lleno.

**Fin del turno (`endPlayerTurn`):**
1. Los aviones sobre un portaaviones propio con lugar aterrizan en él (pasan a ser carga) y repostan.
2. Los aviones que quedan en el aire gastan los MP que no usaron ("loiter"): así un caza con 20 de combustible y 10 MP aguanta dos turnos fuera de base. Con 0 combustible y lejos de una base, se estrellan.
3. Suministro: una unidad terrestre está abastecida si hay un camino por tierra hasta una ciudad propia sin cruzar enemigos ni ciudades ajenas, o si va embarcada. Si no, suma un turno; después de 3 pierde 25% de defensa. Se avisa cada turno que está cortada.
4. Se evalúa la victoria; el siguiente jugador vivo empieza su turno. Al dar la vuelta, la ronda avanza.

**Eliminación en el medio.** Una captura o un derribo pueden terminar la partida (o eliminar a alguien) en plena jugada. Las fuerzas que le queden al eliminado se rinden (se retiran del mapa) y la rotación lo saltea.

**Eventos con audiencia.** Cada `TurnEvent` indica a quién se le puede contar (`audience`: un jugador o `all`): la producción, los derribos y los avisos de suministro son privados; eliminaciones y victoria son públicas.

## 3e. Generación de mapas

`generateMap(settings, players)` devuelve un `WorldState` listo para `Match.start`, las capitales y un informe. **Todo depende de la semilla** (`Rng` sfc32 + hash cyrb128; `core` nunca usa `Math.random`): la misma semilla da el mismo mapa, lo que permite compartir mapas y reproducir partidas.

| Opción | Valores |
|---|---|
| Tamaño | Small 60×40, Medium 100×64, Huge 160×100 (o a medida) |
| Densidad de islas | sparse 22% de tierra, normal 32%, dense 42% |
| Ciudades | ≈1 cada 18 casillas de tierra (configurable) |
| Unidades iniciales | por defecto una infantería en la capital |

**Pasos:**
1. Relieve con ruido simplex fractal (islas de ≈11 casillas de diámetro) y un borde de océano; el nivel del mar se fija en el percentil exacto que da la proporción de tierra pedida.
2. Se hunden los islotes de menos de 3 casillas. Lo más alto se vuelve montaña (6%) y colina (12%); un segundo campo de "humedad" planta bosques; el agua junto a la costa es poco profunda.
3. Ciudades: se ordenan los sitios por calidad (costa > llanura, con algo de azar) y se aceptan con una separación mínima de 3; nunca en montañas.
4. Capitales: entre ciudades costeras de islas con lugar para al menos otra ciudad. Se eligen con muestreo del punto más lejano desde 24 arranques al azar y luego se refinan moviendo cada capital a ciudades cercanas mientras mejore el puntaje.
5. **Puntaje de equidad:** cada ciudad neutral cuenta para la capital más cercana, con peso `exp(-distancia/10)`; equilibrio = potencial del más débil / del más fuerte. Se penalizan capitales demasiado juntas.
6. Si el equilibrio no llega a 0.8, se regenera el mapa entero con otra rama de la semilla (hasta 12 intentos) y se queda el mejor.

Medido sobre 15 semillas por combinación (3 tamaños × 3 densidades × 2/4/6 jugadores): ninguna falla, equilibrio mínimo 0.67–0.94 y mediana 0.81–0.99; un mapa Huge para 6 jugadores tarda <100 ms.

## 3f. Visor local (`packages/client`)

Primer cliente: Vite + TypeScript + Canvas 2D, sin framework. Juega partidas locales por turnos (hot-seat) usando `Match` exactamente como lo hará el servidor, y **sólo dibuja el `PlayerView` del jugador activo**: entre turnos una pantalla opaca oculta el mapa hasta que el siguiente jugador toma el control.

- `session.ts`: sesión de juego sin DOM (comandos, órdenes de varios turnos "ir a", registro de eventos filtrado por audiencia, guardado). Tiene tests propios.
- `renderer.ts`: mapa con zoom y desplazamiento, costas, relieve, niebla (negro = sin explorar, velo = recordado), ciudades y fichas cuya forma indica el dominio (cuadrado = tierra, casco = mar, rombo = aire), alcance del turno y ruta con marcadores de turno; minimapa.
- `main.ts`: interfaz (panel de unidad y de ciudad con producción y especialización, registro táctico, nueva partida con semilla), mouse, teclado y gestos táctiles. Autoguardado en `localStorage`.
- `scripts/build-standalone.mjs`: empaqueta todo en un único HTML.

El atacar todavía no existe (Fase 3): hacer clic sobre un enemigo lo avisa.

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
1. ~~Movimiento: validación de pasos, caminos A\*, alcance, interrupción al contacto~~ (hecho).
2. ~~Captura de ciudades, asalto anfibio y condiciones de victoria~~ (hecho).
3. ~~Ciclo de turno: producción, reparación, combustible, aterrizaje en portaaviones, suministro, rotación y victoria~~ (hecho).
4. ~~Generador de mapas con semilla reproducible y reparto equitativo~~ (hecho). **Fase 1 completa.**

## 6. Fase 2 (siguiente)
1. `packages/protocol`: mensajes cliente↔servidor tipados y validados (zod), versionados.
2. `packages/server`: Fastify + `ws`; salas con código de invitación, configuración de mapa, `Match` en memoria + persistencia de snapshots, deltas de niebla por jugador, reconexión, reloj de turno.
3. IDs opacos por observador en `PlayerView`.
4. Bot simple de reemplazo para jugadores desconectados (usa `PlayerView` + `findPath`).

Pendientes de diseño anotados: límites de apilamiento y zonas de control (no están en la especificación, se pueden sumar en `checkStep`). Además, los IDs secuenciales filtran cuántas unidades produjo un rival; antes de la Fase 2 conviene usar IDs opacos por observador en `PlayerView`.
