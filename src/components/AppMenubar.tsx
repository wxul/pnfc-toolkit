import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from "@/components/ui/menubar";

export function AppMenubar({
  onOpenDevPanel,
  onOpenAbout,
}: {
  onOpenDevPanel: () => void;
  onOpenAbout: () => void;
}) {
  return (
    <Menubar className="h-full shrink-0 gap-0 rounded-none border-none bg-transparent p-0 shadow-none">
      <MenubarMenu>
        <MenubarTrigger className="text-xs text-muted-foreground">Help</MenubarTrigger>
        <MenubarContent className="w-auto min-w-fit whitespace-nowrap">
          <MenubarItem
            className="whitespace-nowrap text-xs text-muted-foreground"
            onClick={onOpenDevPanel}
          >
            Development
          </MenubarItem>
          <MenubarItem
            className="whitespace-nowrap text-xs text-muted-foreground"
            onClick={onOpenAbout}
          >
            About pnfc-toolkit
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}
