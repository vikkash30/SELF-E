import { BrowserRouter, Route, Routes } from 'react-router-dom';
import DoctorDashboard from './DoctorDashboard.jsx';
import IoTSimulator from './IoTSimulator.jsx';
import LanguageSelection from './pages/LanguageSelection.jsx';
import OperatorDashboard from './OperatorDashboard.jsx';
import ReminderDashboard from './ReminderDashboard.jsx';
import VoiceRemindersPage from './VoiceRemindersPage.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LanguageSelection />} />
        <Route path="/language" element={<LanguageSelection />} />
        <Route path="/operator" element={<OperatorDashboard />} />
        <Route path="/doctor" element={<DoctorDashboard />} />
        <Route path="/iot" element={<IoTSimulator />} />
        <Route path="/reminders" element={<VoiceRemindersPage />} />
        <Route path="/admin/reminders" element={<ReminderDashboard />} />
        <Route path="*" element={<OperatorDashboard />} />
      </Routes>
    </BrowserRouter>
  );
}
