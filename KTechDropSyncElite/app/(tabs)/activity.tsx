import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useServer } from '@/context/ServerContext';

export default function ActivityScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const server = useServer();
  const [textInput, setTextInput] = useState('');
  const isDark = useColorScheme() === 'dark';
  const bottomPad = insets.bottom + 80;

  const handleSend = () => {
    const t = textInput.trim();
    if (!t) return;
    server.sendText(t);
    setTextInput('');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleCopy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  return (
    <View style={[styles.root, { backgroundColor: isDark ? '#0f0a1e' : '#f5f3ff' }]}>
      <LinearGradient
        colors={['#4f46e5', '#667eea', '#764ba2']}
        style={[styles.header, { paddingTop: insets.top + 20 }]}
      >
        <Text style={styles.headerTitle}>Live Activity</Text>
        <Text style={styles.headerSub}>Text Clipboard & Transfer Logs</Text>
      </LinearGradient>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }} keyboardShouldPersistTaps="handled">
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground, marginBottom: 8 }]}>
              💬 Send Text to Browser
            </Text>
            <View style={[styles.inputRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <TextInput
                style={[styles.textInput, { color: colors.foreground }]}
                value={textInput}
                onChangeText={setTextInput}
                placeholder="Type or paste text..."
                placeholderTextColor={colors.mutedForeground}
                multiline
              />
              <TouchableOpacity onPress={handleSend} style={styles.sendBtn}>
                <MaterialCommunityIcons name="send" size={20} color="white" />
              </TouchableOpacity>
            </View>

            {server.texts.map((t) => (
              <View key={t.id} style={[styles.textItem, { backgroundColor: colors.card }]}>
                <View style={styles.textMeta}>
                  <Text style={styles.sourceText}>{t.source === 'browser' ? '💻 Browser' : '📱 Phone'}</Text>
                  <TouchableOpacity onPress={() => handleCopy(t.text)}>
                    <MaterialCommunityIcons name="content-copy" size={16} color="#667eea" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => server.deleteText(t.id)}>
                    <MaterialCommunityIcons name="trash-can-outline" size={16} color="#ef4444" />
                  </TouchableOpacity>
                </View>
                <Text style={[styles.textContent, { color: colors.foreground }]}>{t.text}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  headerTitle: { color: '#fff', fontSize: 24, fontWeight: '800' },
  headerSub: { color: 'rgba(255,255,255,0.75)', fontSize: 13, marginTop: 2 },
  section: { margin: 16 },
  sectionTitle: { fontSize: 15, fontWeight: '700' },
  inputRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, padding: 8, marginBottom: 14 },
  textInput: { flex: 1, fontSize: 14, minHeight: 40 },
  sendBtn: { width: 38, height: 38, borderRadius: 10, backgroundColor: '#667eea', alignItems: 'center', justifyContent: 'center' },
  textItem: { borderRadius: 10, padding: 12, marginBottom: 8 },
  textMeta: { flexDirection: 'row', gap: 10, alignItems: 'center', marginBottom: 6 },
  sourceText: { fontSize: 11, fontWeight: '700', color: '#667eea', flex: 1 },
  textContent: { fontSize: 13.5, lineHeight: 18 },
});