import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function PageStub({
  title,
  description,
  step,
}: {
  title: string;
  description: string;
  step: string;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bientôt disponible</CardTitle>
          <CardDescription>Cette section arrive dans une prochaine étape du développement.</CardDescription>
        </CardHeader>
        <CardContent>
          <Badge variant="secondary">{step}</Badge>
        </CardContent>
      </Card>
    </div>
  );
}
