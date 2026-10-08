import Navbar from "./components/Navbar/Navbar";
import Hero from "./components/Hero/Hero";
import IntroSection from "./components/IntroSection/IntroSection";
import RidingPrograms from "./components/RidingPrograms/RidingPrograms";
import FlexibleRiding from "./components/FlexibleRiding/FlexibleRiding";
import CertificateSection from "./components/CertificateSection/CertificateSection";
import AboutSection from "./components/AboutSection/AboutSection";
import FinalCTA from "./components/FinalCTA/FinalCTA";
import Footer from "./components/Footer/Footer";
import PracticalInfo from "./components/PracticalInfo/PracticalInfo";
import EnquiryModal from "./components/EnquiryModal/EnquiryModal";
import AuthModal from "./components/AuthModal/AuthModal";
import { EnquiryModalProvider } from "./context/EnquiryModalContext";
import { useSmoothScroll } from "./lib/smoothScroll";

export default function App() {
  useSmoothScroll();

  return (
    <EnquiryModalProvider>
      <div className="min-h-screen bg-warm-ivory">
        <Navbar />
        {/* Light and dark sections are grouped into a few calm bands instead
            of flipping colour every section:
            dark hero → light (intro, programmes) → dark (pace, certificate)
            → light (practical info, about) → dark (contact, footer). */}
        <main>
          <Hero />
          <IntroSection />
          <RidingPrograms />
          <FlexibleRiding />
          <CertificateSection />
          <PracticalInfo />
          <AboutSection />
          <FinalCTA />
        </main>
        <Footer />
        <EnquiryModal />
        <AuthModal />
      </div>
    </EnquiryModalProvider>
  );
}
