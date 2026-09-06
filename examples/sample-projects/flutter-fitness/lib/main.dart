import 'package:flutter/material.dart';

void main() => runApp(const FitnessApp());

class FitnessApp extends StatelessWidget {
  const FitnessApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Fitness')),
        body: const Center(child: Text('Шаги: 0')),
      ),
    );
  }
}
