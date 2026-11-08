/**
 * "Primeros pasos": a short guided tour driven by what the player actually does.
 * Each step names one action; doing it (or pressing "Siguiente") advances. Shown on
 * the first game in this browser, and again from the help screen.
 */
export type TutorialAction = 'select' | 'move' | 'city' | 'capture' | 'end' | 'attack';

interface Step {
  readonly action: TutorialAction;
  readonly title: string;
  readonly text: string;
}

const STEPS: readonly Step[] = [
  { action: 'select', title: 'Elegí una unidad', text: 'Hacé clic en tu infantería, o apretá N para ir a la próxima unidad que puede moverse. La activa tiene un halo dorado y una flecha.' },
  { action: 'move', title: 'Movela', text: 'Pasá el cursor por el mapa: verás la ruta y en cuántos turnos llega. Hacé clic en el destino. Si está lejos, la unidad sigue sola los turnos siguientes.' },
  { action: 'city', title: 'Elegí qué producir', text: 'Hacé clic en tu ciudad (la del marco de color) y elegí la unidad en "Producción". No hay dinero: cada unidad tarda unos turnos.' },
  { action: 'capture', title: 'Conquistá', text: 'Llevá infantería a una ciudad neutral (gris) y entrá: la capturás. Más ciudades, más producción y un ejército más grande.' },
  { action: 'end', title: 'Terminá el turno', text: 'Apretá Enter o "Fin de turno". La computadora juega y vuelve tu turno con un resumen de lo que pasó.' },
  { action: 'attack', title: 'Atacá', text: 'Los enemigos a tiro tienen una mira roja; con mira punteada, la unidad se mueve y ataca en un solo clic. Abajo ves el daño estimado antes de decidir.' },
];

const DONE_KEY = 'strategic-conquest:tutorial-done';

export class Tutorial {
  private step = 0;
  private readonly el: HTMLElement;
  private active = false;

  constructor(host: HTMLElement) {
    this.el = document.createElement('section');
    this.el.className = 'tutorial';
    this.el.setAttribute('aria-live', 'polite');
    this.el.hidden = true;
    host.append(this.el);
    let seen = false;
    try {
      seen = localStorage.getItem(DONE_KEY) === '1';
    } catch {
      /* storage unavailable: show it */
    }
    if (!seen) this.restart();
  }

  restart(): void {
    this.step = 0;
    this.active = true;
    this.render();
  }

  /** The player did something: advance if it is what the current step asks for. */
  done(action: TutorialAction): void {
    if (!this.active || STEPS[this.step]?.action !== action) return;
    this.advance();
  }

  private advance(): void {
    this.step++;
    if (this.step >= STEPS.length) return this.finish();
    this.render();
  }

  private finish(): void {
    this.active = false;
    this.el.hidden = true;
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      /* storage unavailable */
    }
  }

  private render(): void {
    const s = STEPS[this.step]!;
    this.el.innerHTML = `
      <header><small>Primeros pasos · ${this.step + 1}/${STEPS.length}</small>
        <div class="dots" aria-hidden="true">${STEPS.map((_, i) => `<i class="${i < this.step ? 'done' : i === this.step ? 'now' : ''}"></i>`).join('')}</div></header>
      <h3>${s.title}</h3>
      <p>${s.text}</p>
      <div class="row"><button type="button" class="btn small" data-act="next">${this.step === STEPS.length - 1 ? 'Terminar' : 'Siguiente'}</button><button type="button" class="btn small ghost" data-act="skip">Saltar tutorial</button></div>`;
    this.el.hidden = false;
    this.el.querySelector('[data-act=next]')!.addEventListener('click', () => this.advance());
    this.el.querySelector('[data-act=skip]')!.addEventListener('click', () => this.finish());
  }
}
