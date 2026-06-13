/**
 * The app frame: a slim editorial header with the product mark, primary nav
 * (Dashboard / Learn / Review / Progress), and sign-out. Content sits in a
 * centred reading-width column. The shell is intentionally quiet — one hairline
 * border under the header, no shadow — so the content carries the page.
 */
import { Suspense } from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  BookOpen,
  ClipboardCheck,
  GraduationCap,
  LayoutDashboard,
  Loader2,
  LogOut,
  RotateCcw,
  Share2,
  TrendingUp,
} from "lucide-react";
import { clsx } from "clsx";
import { useAuth } from "../lib/auth";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/learn", label: "Learn", icon: GraduationCap, end: false },
  { to: "/review", label: "Review", icon: RotateCcw, end: false },
  { to: "/exam", label: "Exam", icon: ClipboardCheck, end: false },
  { to: "/graph", label: "Graph", icon: Share2, end: false },
  { to: "/progress", label: "Progress", icon: TrendingUp, end: false },
];

export function AppShell() {
  const { user, signOut } = useAuth();
  const who = user?.displayName ?? user?.email ?? "Signed in";

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-5">
          <NavLink to="/" className="flex items-center gap-2 text-ink">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent/10 text-accent">
              <BookOpen size={16} />
            </span>
            <span className="font-serif text-lg tracking-tight">Tutor</span>
          </NavLink>

          <nav className="flex items-center gap-0.5">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  clsx(
                    "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-ink/[0.06] text-ink"
                      : "text-muted hover:text-ink",
                  )
                }
              >
                <Icon size={15} />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>

          <button
            onClick={() => void signOut()}
            title={`Sign out (${who})`}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:text-ink"
          >
            <LogOut size={16} />
            <span className="hidden md:inline">Sign out</span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-8 sm:py-10">
        <Suspense
          fallback={
            <div className="grid place-items-center py-20 text-muted">
              <Loader2 size={18} className="animate-spin" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
