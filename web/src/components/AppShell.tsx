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
  Layers,
  LayoutDashboard,
  Loader2,
  LogOut,
  RotateCcw,
  Settings as SettingsIcon,
  DoorOpen,
  Share2,
  TrendingUp,
  Users,
} from "lucide-react";
import { clsx } from "clsx";
import { useAuth } from "../lib/auth";
import { StreakBadge } from "./StreakBadge";
import { usePresenceHeartbeat } from "../lib/presence";
import { useProfile } from "../lib/social";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/learn", label: "Learn", icon: GraduationCap, end: false },
  { to: "/review", label: "Review", icon: RotateCcw, end: false },
  { to: "/flashcards", label: "Cards", icon: Layers, end: false },
  { to: "/exam", label: "Exam", icon: ClipboardCheck, end: false },
  { to: "/graph", label: "Graph", icon: Share2, end: false },
  { to: "/progress", label: "Progress", icon: TrendingUp, end: false },
  { to: "/friends", label: "Friends", icon: Users, end: false },
  { to: "/rooms", label: "Rooms", icon: DoorOpen, end: false },
];

export function AppShell() {
  const { user, signOut } = useAuth();
  const who = user?.displayName ?? user?.email ?? "Signed in";

  // App-wide collaboration plumbing: ensure the public profile exists, and keep
  // this user's presence heartbeat fresh while the app is open.
  useProfile();
  usePresenceHeartbeat();

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-5">
          <div className="flex items-center gap-2.5">
            <NavLink to="/" className="flex items-center gap-2 text-ink">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent/10 text-accent">
                <BookOpen size={16} />
              </span>
              <span className="font-serif text-lg tracking-tight">Tutor</span>
            </NavLink>
            <StreakBadge />
          </div>

          <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  clsx(
                    "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
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

          <div className="flex shrink-0 items-center gap-0.5">
            <NavLink
              to="/settings"
              title="Settings"
              className={({ isActive }) =>
                clsx(
                  "grid h-8 w-8 place-items-center rounded-lg transition-colors",
                  isActive ? "bg-ink/[0.06] text-ink" : "text-muted hover:text-ink",
                )
              }
            >
              <SettingsIcon size={16} />
            </NavLink>
            <button
              onClick={() => void signOut()}
              title={`Sign out (${who})`}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:text-ink"
            >
              <LogOut size={16} />
              <span className="hidden md:inline">Sign out</span>
            </button>
          </div>
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
