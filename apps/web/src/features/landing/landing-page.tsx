import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { LanguageSwitcher } from '@/components/layout/language-switcher';

/**
 * The public front page: what an anonymous visitor sees at `/` (RequireAuth renders it instead of sending them to the
 * sign-in form). Deep links into the app still go straight to sign-in, and a signed-in member gets the dashboard here.
 *
 * It is FlowZa's own page, not a tenant's, so it pins the signature style (`data-theme="emerald"`) whatever style the
 * last signed-in organisation left on <html>.
 */
export function LandingPage() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  return (
    <div data-theme="emerald" className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-2.5 rounded-lg" aria-label={t('app.name')}>
            <img src="/favicon.svg" alt="" className="size-10 rounded-lg" />
            <span className="hidden text-base font-semibold sm:inline">{t('app.name')}</span>
          </Link>
          <nav aria-label={t('landing.nav')} className="flex items-center gap-1 sm:gap-2">
            <Link to="/" aria-current="page" className="hidden h-9 items-center rounded-md px-3 text-sm font-medium hover:bg-accent sm:inline-flex">{t('landing.home')}</Link>
            <Link to="/auth/sign-in" className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium hover:bg-accent">{t('auth.signIn')}</Link>
            <Button asChild size="sm" className="hidden h-9 px-4 sm:inline-flex"><Link to="/auth/sign-up">{t('auth.signUp')}</Link></Button>
            <LanguageSwitcher />
          </nav>
        </div>
      </header>

      <main className="relative isolate flex flex-1 items-center overflow-hidden bg-brand-900 text-white">
        <HeroBackdrop />
        <div className="mx-auto w-full max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
          <Wordmark />
          <p className="mt-10 flex items-center justify-center gap-4 text-4xl leading-none sm:mt-12 sm:gap-6 sm:text-6xl">
            <span className="font-bold tracking-tight">{t('landing.taglineStrong')}</span>
            <span aria-hidden className="h-1.5 w-14 shrink-0 rounded-full bg-white sm:h-2 sm:w-24" />
            <span className="font-light">{t('landing.taglineSoft')}</span>
          </p>
          <div className="mx-auto mt-10 max-w-3xl sm:mt-14">
            <h1 className="text-3xl font-semibold leading-tight tracking-tight text-balance sm:text-5xl">{t('landing.title')}</h1>
            <p className="mt-4 max-w-prose text-base text-white/85 sm:text-lg">{t('landing.description')}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg" className="h-12 min-w-44 bg-white px-8 text-base text-brand-800 hover:bg-brand-50">
                <Link to="/auth/sign-in">{t('auth.signIn')}</Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-12 min-w-44 border-white/60 bg-transparent px-8 text-base text-white hover:bg-white/10 hover:text-white">
                <Link to="/auth/sign-up">{t('auth.signUp')}</Link>
              </Button>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t bg-card">
        <div className="mx-auto flex max-w-7xl flex-col items-center gap-1.5 px-4 py-6 text-center text-xs text-muted-foreground">
          <p>{t('app.name')} — {t('app.tagline')}</p>
          {/* The brand line is an LTR island so "© 2026 FlowZa" keeps its order inside Arabic text. */}
          <p><span dir="ltr">© {year} <span className="font-semibold text-primary dark:text-brand-300">FlowZa</span></span>. {t('landing.rights')}</p>
        </div>
      </footer>
    </div>
  );
}

/** The logo lockup over the hero, bilingual like the app name. Decorative: the page's <h1> carries the name. */
function Wordmark() {
  return (
    <div aria-hidden dir="ltr" className="flex flex-col items-center">
      <div className="flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="size-12 rounded-xl ring-1 ring-white/25 sm:size-14" />
        <span className="text-4xl font-bold tracking-tight sm:text-5xl">FlowZa</span>
      </div>
      <span className="mt-2 flex items-center gap-3 text-sm font-medium text-brand-200">
        <span className="uppercase tracking-[0.35em]">time</span>
        <span lang="ar">تايم</span>
      </span>
    </div>
  );
}

// 10:10, the watch-face pose: hour hand at 10 (300°), minute hand at 2 (60°), clockwise from 12.
const CLOCK = { cx: 1160, cy: 200 };
const point = (deg: number, r: number) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: Math.round((CLOCK.cx + r * Math.cos(rad)) * 100) / 100, y: Math.round((CLOCK.cy + r * Math.sin(rad)) * 100) / 100 };
};
const TICKS = Array.from({ length: 12 }, (_, i) => ({ from: point(i * 30, 142), to: point(i * 30, i % 3 === 0 ? 166 : 158) }));
const HANDS = [point(300, 80), point(60, 120)];

/**
 * Layered waves and a faint clock face in the brand scale. Every layer is translucent over `brand-900`, and even where
 * all of them stack the result is no lighter than `brand-600`, so white text keeps ≥ 4.5:1 anywhere on the hero.
 */
function HeroBackdrop() {
  return (
    <>
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,var(--brand-700),transparent_65%)] opacity-70" />
      <svg aria-hidden className="absolute inset-0 -z-10 size-full" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" fill="none">
        <g className="stroke-white" strokeLinecap="round">
          <circle cx={CLOCK.cx} cy={CLOCK.cy} r="176" strokeOpacity="0.1" strokeWidth="1.5" />
          <circle cx={CLOCK.cx} cy={CLOCK.cy} r="230" strokeOpacity="0.06" strokeWidth="1" />
          <circle cx={CLOCK.cx} cy={CLOCK.cy} r="290" strokeOpacity="0.04" strokeWidth="1" />
          {TICKS.map((tick, i) => <line key={i} x1={tick.from.x} y1={tick.from.y} x2={tick.to.x} y2={tick.to.y} strokeOpacity="0.16" strokeWidth={i % 3 === 0 ? 3 : 2} />)}
          {HANDS.map((hand, i) => <line key={i} x1={CLOCK.cx} y1={CLOCK.cy} x2={hand.x} y2={hand.y} strokeOpacity="0.14" strokeWidth={i === 0 ? 5 : 3} />)}
        </g>
        <path className="fill-brand-800" fillOpacity="0.6" d="M0 520C240 470 480 590 720 540S1200 470 1440 530V900H0Z" />
        <path className="fill-brand-700" fillOpacity="0.55" d="M0 610C260 560 520 680 760 630S1220 560 1440 620V900H0Z" />
        <path className="fill-brand-600" fillOpacity="0.45" d="M0 710C280 660 540 770 800 720S1240 660 1440 720V900H0Z" />
        <path className="fill-brand-500" fillOpacity="0.35" d="M0 800C300 760 560 850 820 805S1260 760 1440 810V900H0Z" />
        <g className="stroke-white" strokeLinecap="round">
          <path strokeOpacity="0.14" strokeWidth="2" strokeDasharray="2 10 40 14" d="M0 612C260 562 520 682 760 632S1220 562 1440 622" />
          <path strokeOpacity="0.18" strokeWidth="2.5" strokeDasharray="1 8 60 12" d="M0 712C280 662 540 772 800 722S1240 662 1440 722" />
          <path strokeOpacity="0.22" strokeWidth="3" strokeDasharray="1 6 80 10" d="M0 802C300 762 560 852 820 807S1260 762 1440 812" />
        </g>
        <path className="stroke-brand-300" strokeOpacity="0.25" strokeWidth="1.5" d="M0 522C240 472 480 592 720 542S1200 472 1440 532" />
      </svg>
    </>
  );
}
