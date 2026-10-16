import { Chat } from "@/components/Chat";
import { getIndex } from "@/lib/kb";

export default function Page() {
  // The product line is read from the corpus rather than written into the UI. A
  // document dropped into the knowledge base changes what this page offers to
  // answer, with nothing to remember to update in two places.
  return <Chat products={[...getIndex().products]} />;
}
