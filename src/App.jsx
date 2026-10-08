import Navbar from "./components/Navbar/Navbar";
import Hero from "./components/Hero/Hero";
import IntroSection from "./components/IntroSection/IntroSection";
import RidingPrograms from "./components/RidingPrograms/RidingPrograms";
import FlexibleRiding from "./components/FlexibleRiding/FlexibleRiding";
import CertificateSection from "./components/CertificateSection/CertificateSection";
import AboutSection from "./components/AboutSection/AboutSection";
import FinalCTA from "./components/FinalCTA/FinalCTA";
import Footer from "./components/Footer/Footer";
import SectionDivider from "./components/ui/SectionDivider";
import LoadCurtain from "./components/LoadCurtain/LoadCurtain";
import Cursor from "./components/Cursor/Cursor";
import EnquiryModal from "./components/EnquiryModal/EnquiryModal";
import AuthModal from "./components/AuthModal/AuthModal";
import { EnquiryModalProvider } from "./context/EnquiryModalContext";
import { useSmoothScroll } from "./lib/smoothScroll";

const COLOR = {
  deepForest: "#081c15",
  racingGreen: "#12372a",
  warmIvory: "#f6f2e8",
  softCream: "#ede7d8",
};

export default function App() {
  useSmoothScroll();

  return (
    <EnquiryModalProvider>
      <div className="min-h-screen bg-warm-ivory">
        <LoadCurtain />
        <Cursor />
        <Navbar />
        <main>
          <Hero />
          <SectionDivider from={COLOR.deepForest} to={COLOR.warmIvory} />
          <IntroSection />
          <RidingPrograms />
          <FlexibleRiding />
          <SectionDivider from={COLOR.racingGreen} to={COLOR.warmIvory} flip />
          <CertificateSection />
          <SectionDivider from={COLOR.deepForest} to={COLOR.softCream} />

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
