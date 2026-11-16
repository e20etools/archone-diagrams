import { AppWindow, Bot, BrainCircuit, Plug, Boxes, Circle, Cog, Container, Database, Diamond, Globe, HardDrive, Layers, ListOrdered, Monitor, Puzzle, Server, Shield, Smartphone, Split, SquareCheck, User, Workflow, Zap, type LucideIcon } from "lucide-react";
import { objectType } from "@/lib/catalog";

const ICONS: Record<string, LucideIcon> = {
  layers: Layers,
  user: User,
  boxes: Boxes,
  globe: Globe,
  app: AppWindow,
  monitor: Monitor,
  phone: Smartphone,
  cog: Cog,
  database: Database,
  queue: ListOrdered,
  zap: Zap,
  drive: HardDrive,
  split: Split,
  server: Server,
  container: Container,
  shield: Shield,
  puzzle: Puzzle,
  bot: Bot,
  brain: BrainCircuit,
  plug: Plug,
  workflow: Workflow,
  task: SquareCheck,
  event: Circle,
  decision: Diamond,
};

export function TypeIcon({ typeId, size = 16 }: { typeId: string; size?: number }) {
  const Icon = ICONS[objectType(typeId).icon] ?? AppWindow;
  return <Icon size={size} strokeWidth={1.75} aria-hidden />;
}
