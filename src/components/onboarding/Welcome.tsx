import { useState } from "react";
import { useAppStore } from "@/lib/store";
import { ThemedMascotImg } from "@/components/common/ThemedMascotImg";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight } from "lucide-react";

export function Welcome() {
  const { userName, setUserName } = useAppStore();
  const [name, setName] = useState("");

  if (userName) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      setUserName(name.trim());
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/5" />

      <div className="relative w-full max-w-sm px-6">
        <div className="mb-8 text-center">
          <ThemedMascotImg
            base="/penguin.png"
            alt="Penguin"
            className="mx-auto mb-4 h-32 object-contain drop-shadow-lg"
            draggable={false}
          />
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Penguin
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your gRPC and JS-SDK testing companion
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              What should we call you?
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              autoFocus
              className="h-10 text-sm"
              autoCorrect="off"
              autoCapitalize="words"
              spellCheck={false}
            />
          </div>
          <Button
            type="submit"
            className="w-full h-10"
            disabled={!name.trim()}
          >
            Get Started
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </form>

        <p className="mt-6 text-center text-[10px] text-muted-foreground/50">
          gRPC-Web · gRPC · JS-SDK
        </p>
      </div>
    </div>
  );
}
