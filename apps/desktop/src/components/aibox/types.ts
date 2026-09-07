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

// Static color map — avoids Tailwind purging issues with dynamic class names
export const COLOR_MAP: Record<string, { text: string; bg: string; border: string }> = {
  yellow: { text: 'text-amber-700',  bg: 'bg-amber-100',  border: 'border-amber-300' },
  orange: { text: 'text-orange-700', bg: 'bg-orange-100', border: 'border-orange-300' },
  blue:   { text: 'text-blue-700',   bg: 'bg-blue-100',   border: 'border-blue-300' },
  purple: { text: 'text-purple-700', bg: 'bg-purple-100', border: 'border-purple-300' },
  green:  { text: 'text-green-700',  bg: 'bg-green-100',  border: 'border-green-300' },
  cyan:   { text: 'text-cyan-700',   bg: 'bg-cyan-100',   border: 'border-cyan-300' },
  red:    { text: 'text-red-700',    bg: 'bg-red-100',    border: 'border-red-300' },
  pink:   { text: 'text-pink-700',   bg: 'bg-pink-100',   border: 'border-pink-300' },
  gray:   { text: 'text-gray-700',   bg: 'bg-gray-100',   border: 'border-gray-300' },
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
