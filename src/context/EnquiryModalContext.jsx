import { createContext, useContext, useMemo, useState } from "react";

const EnquiryModalContext = createContext(null);

export function EnquiryModalProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false);
  const [topic, setTopic] = useState(null);

  const value = useMemo(
    () => ({
      isOpen,
      topic,
      /**
       * `topic` personalizes the form (e.g. a service name) — optional.
       * Guarded to a string: passing this directly as `onClick={openEnquiry}`
       * (rather than `onClick={() => openEnquiry()}`) hands it the DOM
       * click event as the first argument, which isn't renderable JSX.
       */
      openEnquiry: (nextTopic) => {
        setTopic(typeof nextTopic === "string" ? nextTopic : null);
        setIsOpen(true);
      },
      closeEnquiry: () => setIsOpen(false),
    }),
    [isOpen, topic]
  );

  return <EnquiryModalContext.Provider value={value}>{children}</EnquiryModalContext.Provider>;
}

export function useEnquiryModal() {
  const ctx = useContext(EnquiryModalContext);
  if (!ctx) throw new Error("useEnquiryModal must be used within an EnquiryModalProvider");
  return ctx;
}
