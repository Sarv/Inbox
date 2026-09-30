import type { EmailRecord } from '@sarvinbox/core';
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Star,
  Bell,
  MessageCircle,
  Clock,
  Calendar,
  Receipt,
  Tag,
  Flag,
  Heart,
  Zap,
  Shield,
  AlertCircle,
  Bookmark,
  Briefcase,
  CreditCard,
  DollarSign,
  FileText,
  Gift,
  Globe,
  Inbox,
  Mail,
  MapPin,
  Megaphone,
  Newspaper,
  Package,
  Plane,
  ShoppingCart,
  Truck,
  Users,
  Wrench,
} from 'lucide-react';

/** Dynamic category counts — keyed by slug */
export type AICategoryCounts = Record<string, number>;

export interface AIBoxTab {
  id: string;
  label: string;
  icon: LucideIcon;
  category: string | null; // null = dashboard
}

/** Category definition as returned from IPC */
export interface CategoryDefinition {
  slug: string;
  name: string;
  description: string | null;
  prompt: string;
  icon: string;
  color: string;
  sortOrder: number;
  isSystem: boolean;
  isEnabled: boolean;
}

// Icon map — maps icon name strings to Lucide icon components
export const ICON_MAP: Record<string, LucideIcon> = {
  Star,
  Bell,
  MessageCircle,
  Clock,
  Calendar,
  Receipt,
  Tag,
  Flag,
  Heart,
  Zap,
  Shield,
  AlertCircle,
  LayoutDashboard,
  Bookmark,
  Briefcase,
  CreditCard,
  DollarSign,
  FileText,
  Gift,
  Globe,
  Inbox,
  Mail,
  MapPin,
  Megaphone,
  Newspaper,
  Package,
  Plane,
  ShoppingCart,
  Truck,
  Users,
  Wrench,
};

// Static color map — avoids Tailwind purging issues with dynamic class names.
// Every entry carries dark: variants: the light-mode pastel bg under the dark
// theme's near-white foreground made card titles unreadable.
export const COLOR_MAP: Record<string, { text: string; bg: string; border: string }> = {
  yellow: { text: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-100 dark:bg-amber-500/15', border: 'border-amber-300 dark:border-amber-500/40' },
  orange: { text: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-100 dark:bg-orange-500/15', border: 'border-orange-300 dark:border-orange-500/40' },
  blue:   { text: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-100 dark:bg-blue-500/15', border: 'border-blue-300 dark:border-blue-500/40' },
  purple: { text: 'text-purple-700 dark:text-purple-300', bg: 'bg-purple-100 dark:bg-purple-500/15', border: 'border-purple-300 dark:border-purple-500/40' },
  green:  { text: 'text-green-700 dark:text-green-300', bg: 'bg-green-100 dark:bg-green-500/15', border: 'border-green-300 dark:border-green-500/40' },
  cyan:   { text: 'text-cyan-700 dark:text-cyan-300', bg: 'bg-cyan-100 dark:bg-cyan-500/15', border: 'border-cyan-300 dark:border-cyan-500/40' },
  red:    { text: 'text-red-700 dark:text-red-300', bg: 'bg-red-100 dark:bg-red-500/15', border: 'border-red-300 dark:border-red-500/40' },
  pink:   { text: 'text-pink-700 dark:text-pink-300', bg: 'bg-pink-100 dark:bg-pink-500/15', border: 'border-pink-300 dark:border-pink-500/40' },
  gray:   { text: 'text-gray-700 dark:text-gray-300', bg: 'bg-gray-100 dark:bg-gray-500/15', border: 'border-gray-300 dark:border-gray-500/40' },
};

// Dashboard tab is always first
export const DASHBOARD_TAB: AIBoxTab = {
  id: 'dashboard',
  label: 'Dashboard',
  icon: LayoutDashboard,
  category: null,
};

/**
 * Build dynamic tabs from category definitions.
 * Returns Dashboard + one tab per enabled category.
 */
export function buildTabsFromDefinitions(defs: CategoryDefinition[]): AIBoxTab[] {
  const tabs: AIBoxTab[] = [DASHBOARD_TAB];
  for (const def of defs) {
    tabs.push({
      id: def.slug,
      label: def.name,
      icon: ICON_MAP[def.icon] || Tag,
      category: def.slug,
    });
  }
  return tabs;
}

/**
 * Build a label map from category definitions (for AIBoxCategoryView).
 * Includes 'dashboard' plus all slugs.
 */
export function buildTabLabels(defs: CategoryDefinition[]): Record<string, string> {
  const labels: Record<string, string> = { dashboard: 'Dashboard' };
  for (const def of defs) {
    labels[def.slug] = def.name;
  }
  return labels;
}

export interface CategoryEmailListProps {
  emails: EmailRecord[];
  loading: boolean;
  categoryName: string;
  onSelectEmail: (id: string) => void;
  selectedEmailId: string | null;
}
