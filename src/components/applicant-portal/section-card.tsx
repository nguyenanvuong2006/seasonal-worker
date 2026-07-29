import { Card, CardContent } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ReactNode } from "react";

interface SectionCardProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export default function SectionCard({
  children,
  className,
  contentClassName,
}: SectionCardProps) {
  return (
    <Card
      className={cn(
        "overflow-hidden rounded-[30px] border border-slate-200/70 bg-white shadow-[0_20px_60px_rgba(15,23,42,.08)] transition-all duration-300",
        className
      )}
    >
      <CardContent
        className={cn(
          "p-6 md:p-8",
          contentClassName
        )}
      >
        {children}
      </CardContent>
    </Card>
  );
}
