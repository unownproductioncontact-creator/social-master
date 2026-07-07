export const metadata = { title: "Politique de confidentialité — Social Master" };

export default function PrivacyPage() {
  return (
    <>
      <h1>Politique de confidentialité</h1>
      <p>Dernière mise à jour : 07/07/2026.</p>

      <p>
        Social Master (« le Service ») est un outil de planification de publications pour Instagram et TikTok,
        édité par MEA, société par actions simplifiée unipersonnelle (SASU), dont le siège est situé au 4 avenue
        Philippe de Girard, 93420 Villepinte, France — contact :{" "}
        <a href="mailto:unownproduction.contact@gmail.com">unownproduction.contact@gmail.com</a>. Cette page décrit
        quelles données sont collectées, pourquoi, et comment elles sont protégées.
      </p>

      <h2>1. Données collectées</h2>
      <ul>
        <li><strong>Compte Social Master</strong> : nom, adresse email, mot de passe (haché, jamais stocké en clair).</li>
        <li>
          <strong>Comptes Instagram et TikTok connectés</strong> : identifiant du compte, nom d'utilisateur, photo de
          profil, type de compte, et les jetons d'accès OAuth nécessaires pour publier en votre nom.
        </li>
        <li><strong>Contenus</strong> : images et vidéos que vous importez, légendes, hashtags, dates de programmation.</li>
        <li>
          <strong>Journal d'activité technique</strong> : historique des tentatives de publication et des erreurs,
          conservé pour vous permettre de diagnostiquer un échec.
        </li>
      </ul>

      <h2>2. Utilisation des données</h2>
      <p>
        Les données ci-dessus sont utilisées exclusivement pour faire fonctionner le Service : publier vos contenus
        sur les comptes Instagram et TikTok que vous avez explicitement connectés, aux dates que vous avez choisies.
        Aucune donnée n'est vendue, louée ou partagée avec des tiers à des fins publicitaires ou commerciales.
      </p>

      <h2>3. Jetons d'accès OAuth (Instagram / TikTok)</h2>
      <p>
        Les jetons d'accès délivrés par Meta et TikTok sont chiffrés (AES-256-GCM) avant d'être stockés en base de
        données. Ils ne sont déchiffrés que le temps strictement nécessaire à un appel d'API de publication, et ne
        sont jamais transmis au navigateur ni journalisés en clair. Vous pouvez déconnecter un compte à tout moment
        depuis la page Connexions, ce qui supprime immédiatement le jeton associé.
      </p>

      <h2>4. Conservation et suppression des données</h2>
      <p>
        Les données sont conservées tant que votre compte Social Master est actif. La suppression de votre compte
        entraîne la suppression de toutes les données associées : comptes sociaux connectés, médias, posts et
        historique. Pour demander la suppression de votre compte et de vos données, contactez{" "}
        <a href="mailto:unownproduction.contact@gmail.com">unownproduction.contact@gmail.com</a>.
      </p>

      <h2>5. Sécurité</h2>
      <p>
        Mots de passe hachés (bcrypt), jetons OAuth chiffrés (AES-256-GCM), connexions chiffrées (HTTPS), accès aux
        données strictement limité au propriétaire de chaque compte.
      </p>

      <h2>6. Vos droits</h2>
      <p>
        Conformément au RGPD, vous disposez d'un droit d'accès, de rectification, d'effacement et de portabilité de
        vos données. Pour exercer ces droits, contactez{" "}
        <a href="mailto:unownproduction.contact@gmail.com">unownproduction.contact@gmail.com</a>.
      </p>

      <h2>7. Contact</h2>
      <p>
        MEA — 4 avenue Philippe de Girard, 93420 Villepinte, France
        <br />
        <a href="mailto:unownproduction.contact@gmail.com">unownproduction.contact@gmail.com</a>
      </p>
    </>
  );
}
